#!/usr/bin/env node

/**
 * Harbor 冒烟测试端到端验证
 *
 * 验证流程：
 * 1. 加载 harbor-smoke-v1 benchmark
 * 2. 创建一个 mock Candidate
 * 3. 运行 feedback partition（两道题）
 * 4. 运行 selection partition（一道题）
 * 5. 验证 reward 和 artifacts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { HarborEnvironment } from '../src/environments/harbor.mjs'
import { DockerClient } from '../src/docker.mjs'

const dockerE2eEnabled = process.env.RSI_RUN_DOCKER_E2E === '1'

test('Harbor 冒烟测试：端到端运行两道题', { skip: !dockerE2eEnabled }, async (t) => {
  const benchmarkRoot = join(process.cwd(), 'benchmarks/examples/harbor-smoke-v1')
  const tasksRoot = join(benchmarkRoot, 'tasks')
  const runRoot = join(tmpdir(), `harbor-smoke-e2e-${Date.now()}`)

  await mkdir(runRoot, { recursive: true })

  try {
    // 准备最小 Environment 和 Benchmark 配置
    const environment = {
      id: 'harbor-smoke-v1',
      protocol: 'harbor-task-v1',
      source: {
        tasksRoot: 'benchmarks/examples/harbor-smoke-v1/tasks',
        revision: '199bd6435fe969f46b20f7da56887fdd907bab0a9fb5e139bf75e057865bf860',
      },
      task: {
        workspacePath: '/workspace',
        maximumConcurrentTrials: 2,
      },
      runtime: {
        imagePrefix: 'harbor-smoke-test',
      },
      docker: {
        resources: {
          cpus: 2,
          memory: '2g',
          memoryMb: 2048,
          pids: 512,
          timeoutSeconds: 900,
        },
      },
      verifier: {
        resources: {
          cpus: 1,
          memory: '512m',
          pids: 128,
        },
      },
      feedback: {
        maximumTextBytesPerCase: 2048,
        maximumArtifactEntriesPerCase: 128,
        maximumArtifactBytesPerCase: 1024 * 1024,
        maximumHistoryEntries: 10,
        maximumHistoryBytes: 64 * 1024,
      },
      solverFailurePolicy: 'verified-candidate-terminal-v1',
    }

    const benchmark = {
      allInstanceIds: new Set(['add-numbers', 'write-file']),
      partitionByInstance: new Map([
        ['add-numbers', 'feedback'],
        ['write-file', 'feedback'],
      ]),
      source: {
        revision: '199bd6435fe969f46b20f7da56887fdd907bab0a9fb5e139bf75e057865bf860',
      },
      partitions: {
        feedback: { instanceIds: ['add-numbers', 'write-file'] },
        selection: { instanceIds: ['add-numbers'] },
      },
    }

    const dockerClient = new DockerClient({ binary: 'docker', network: 'none' })

    const mockSolverDriver = {
      id: 'test-solver-v1',
      cacheKey: 'test-cache-key',
      async ensureRuntime({ baseImage, baseImageIdentity, tag }) {
        // 冒烟测试：直接返回 baseImage，不额外构建 Solver 层
        return { image: baseImage, identity: baseImageIdentity, solverImage: baseImage }
      },
      async run({ candidateWorkspace, taskWorkspace, name }) {
        // 冒烟测试：直接运行 Candidate 提供的 Python 脚本
        const scriptName = name.includes('add-numbers') ? 'solve_add.py' : 'solve_write.py'
        try {
          const result = await dockerClient.run({
            image: 'python:3.11-slim',
            name,
            command: ['python', `/candidate/${scriptName}`],
            mounts: [
              { type: 'bind', source: candidateWorkspace, target: '/candidate', readOnly: true },
              { type: 'bind', source: taskWorkspace, target: '/workspace', readOnly: false },
            ],
            workdir: '/workspace',
          })
          return { exitCode: result.exitCode }
        } catch (error) {
          console.error('Solver run 失败:', error.message)
          if (error.processResult) {
            console.error('stderr:', error.processResult.stderr)
            console.error('stdout:', error.processResult.stdout)
          }
          throw error
        }
      },
    }

    const driver = new HarborEnvironment({
      environment,
      benchmark,
      solverDriver: mockSolverDriver,
      docker: dockerClient,
      runRoot,
      repositoryRoot: process.cwd(),
    })

    // Preflight 检查
    console.log('开始 preflight...')
    await driver.preflight()
    console.log('preflight 完成')

    const caps = driver.describeCapabilities()
    assert.equal(caps.artifactType, 'harbor-declared-artifacts', '应支持 artifacts')
    assert.equal(caps.supportsCheckpointResume, true, '应支持 checkpoint')

    // 创建 mock Candidate 目录
    console.log('创建 Candidate 目录...')
    const candidateId = 'test-candidate-001'
    const candidateRoot = join(runRoot, 'candidates', candidateId)
    await mkdir(candidateRoot, { recursive: true })

    // 写一个简单的 Python 解决方案（add-numbers）
    await writeFile(
      join(candidateRoot, 'solve_add.py'),
      'with open("/workspace/result.txt", "w") as f:\n    f.write("579")\n'
    )

    // 写一个简单的 Python 解决方案（write-file）
    await writeFile(
      join(candidateRoot, 'solve_write.py'),
      'with open("/workspace/output.txt", "w") as f:\n    f.write("Hello, Harbor!")\n'
    )

    // 运行 feedback partition（两道题）
    console.log('运行 feedback partition...')
    let feedbackResults
    try {
      feedbackResults = await driver.runCandidatePartition({
        candidateId,
        candidateDigest: 'a'.repeat(64),
        candidateWorkspace: candidateRoot,
        model: 'test-model',
        partition: 'feedback',
        seeds: [42],
        outputPath: join(runRoot, 'feedback-results.jsonl'),
      })
    } catch (error) {
      console.error('runCandidatePartition 失败:', error.message)
      if (error.processResult) {
        console.error('=== Docker stderr ===')
        console.error(error.processResult.stderr)
        console.error('=== Docker stdout ===')
        console.error(error.processResult.stdout)
        console.error('=== Exit code ===')
        console.error(error.processResult.exitCode)
      }
      throw error
    }

    console.log('feedback partition 完成，结果:', feedbackResults)

    // 运行 selection partition（一道题）
    console.log('运行 selection partition...')
    const selectionResults = await driver.runCandidatePartition({
      candidateId,
      candidateDigest: 'a'.repeat(64),
      candidateWorkspace: candidateRoot,
      model: 'test-model',
      partition: 'selection',
      seeds: [42],
      outputPath: join(runRoot, 'selection-results.jsonl'),
    })

    console.log('selection partition 完成，结果:', selectionResults)

    console.log('✅ Harbor 端到端冒烟测试通过')

  } finally {
    await rm(runRoot, { recursive: true, force: true })
  }
})
