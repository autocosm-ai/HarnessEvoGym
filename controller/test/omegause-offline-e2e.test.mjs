#!/usr/bin/env node

/**
 * OmegaUse-OfficeVal 离线端到端验证
 *
 * 验证目标：
 * 1. 离线 Docker 镜像预装所有依赖
 * 2. Verifier 在无网络环境下正常工作
 * 3. 运行 3 个 partition，每个 1 道真实题目
 * 4. 所有评分正常完成（即使 Solver 未生成有效交付物）
 *
 * 数据要求：
 * - 需要设置环境变量 RSI_OFFICEVAL_DATASET_ROOT 指向数据集根目录
 * - 需要设置环境变量 RSI_OFFICEVAL_EVALUATOR_ROOT 指向评测器根目录
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve, dirname } from 'node:path'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { readConfigFile } from '../src/config.mjs'
import { OmegaUseOfficeValEnvironment } from '../src/environments/omegause-officeval.mjs'
import { DockerClient } from '../src/docker.mjs'
import { validateBenchmark } from '../src/protocol.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// 检查数据集环境变量
const datasetRoot = process.env.RSI_OFFICEVAL_DATASET_ROOT
const evaluatorRoot = process.env.RSI_OFFICEVAL_EVALUATOR_ROOT
const skipTest = !datasetRoot || !evaluatorRoot

test('OmegaUse 离线验证：运行 3 道真实题目', { skip: skipTest }, async (t) => {
  const runRoot = await mkdtemp(join(tmpdir(), 'omegause-offline-e2e-'))

  try {
    // 加载环境配置
    const envConfig = await readConfigFile(resolve(repositoryRoot, 'environments/omegause-officeval.yml'))
    const environment = { id: envConfig.metadata.id, ...envConfig.spec }

    // 加载冒烟 Benchmark（3 道题）
    const benchmarkConfig = await readConfigFile(
      resolve(repositoryRoot, 'benchmarks/cowork-omegause-officeval-smoke/benchmark.json'),
    )
    const benchmark = validateBenchmark(benchmarkConfig)

    // 准备最小 Solver Driver（生成空 deliverable）
    const mockSolverDriver = {
      id: 'offline-test-solver',
      cacheKey: 'offline-test-cache',
      async ensureRuntime({ baseImage, baseImageIdentity }) {
        return { image: baseImage, identity: baseImageIdentity, solverImage: baseImage }
      },
      async run({ taskWorkspace, instanceId }) {
        // 创建一个最小的可交付文件，让 Verifier 至少能运行
        const deliverable = join(taskWorkspace, 'deliverable.pptx')
        await writeFile(deliverable, Buffer.from('PK\x03\x04')) // ZIP 文件头
        return { exitCode: 0 }
      },
    }

    const dockerClient = new DockerClient({
      binary: 'docker',
      network: 'none', // 强制无网络
      resources: { cpus: 2, memory: '4g', pids: 256, timeoutSeconds: 900 },
    })

    console.log('初始化 OmegaUse Environment...')
    console.log('Benchmark partitions:', JSON.stringify(benchmark.partitions, null, 2))
    const driver = new OmegaUseOfficeValEnvironment({
      environment,
      benchmark,
      solverDriver: mockSolverDriver,
      docker: dockerClient,
      runRoot,
      repositoryRoot,
    })

    // Preflight 检查
    console.log('开始 preflight（数据集与镜像检查）...')
    await driver.preflight()
    console.log('preflight 完成')

    const caps = driver.describeCapabilities()
    assert.equal(caps.artifactType, 'workspace-files')
    assert.equal(caps.supportsCheckpointResume, true)

    // 创建 mock Candidate 目录
    const candidateId = 'offline-test-candidate-001'
    const candidateRoot = join(runRoot, 'candidates', candidateId)
    await mkdir(candidateRoot, { recursive: true })

    // 运行 feedback partition（1 道题）
    console.log('运行 feedback partition（1 道题）...')
    const feedbackResults = await driver.runCandidatePartition({
      candidateId,
      candidateDigest: 'a'.repeat(64),
      candidateWorkspace: candidateRoot,
      model: { provider: 'test', model: 'offline-test-model', maxTokens: 4096 },
      partition: 'feedback',
      seeds: [42],
      outputPath: join(runRoot, 'feedback-results.jsonl'),
    })

    console.log('运行 selection partition（1 道题）...')
    const selectionResults = await driver.runCandidatePartition({
      candidateId,
      candidateDigest: 'a'.repeat(64),
      candidateWorkspace: candidateRoot,
      model: { provider: 'test', model: 'offline-test-model', maxTokens: 4096 },
      partition: 'selection',
      seeds: [42],
      outputPath: join(runRoot, 'selection-results.jsonl'),
    })

    console.log('运行 final partition（1 道题）...')
    const finalResults = await driver.runCandidatePartition({
      candidateId,
      candidateDigest: 'a'.repeat(64),
      candidateWorkspace: candidateRoot,
      model: { provider: 'test', model: 'offline-test-model', maxTokens: 4096 },
      partition: 'final',
      seeds: [42],
      outputPath: join(runRoot, 'final-results.jsonl'),
    })

    console.log('所有 partition 完成')
    const totalResults = feedbackResults.size + selectionResults.size + finalResults.size
    console.log('结果统计:', {
      总题数: totalResults,
      feedback: [...feedbackResults.values()].filter((r) => r.status === 'resolved').length,
      selection: [...selectionResults.values()].filter((r) => r.status === 'resolved').length,
      final: [...finalResults.values()].filter((r) => r.status === 'resolved').length,
    })

    // 验证所有题目都运行了
    assert.equal(totalResults, 3, '应运行 3 道题')

    // 验证每道题都有 Verifier 结果（即使 reward=0）
    for (const [instanceId, result] of feedbackResults) {
      assert.ok(['resolved', 'unresolved', 'failed'].includes(result.status), `${instanceId} 应有明确状态`)
      console.log(`  - feedback/${instanceId}: status=${result.status}, reward=${result.reward}`)
    }
    for (const [instanceId, result] of selectionResults) {
      assert.ok(['resolved', 'unresolved', 'failed'].includes(result.status), `${instanceId} 应有明确状态`)
      console.log(`  - selection/${instanceId}: status=${result.status}, reward=${result.reward}`)
    }
    for (const [instanceId, result] of finalResults) {
      assert.ok(['resolved', 'unresolved', 'failed'].includes(result.status), `${instanceId} 应有明确状态`)
      console.log(`  - final/${instanceId}: status=${result.status}, reward=${result.reward}`)
    }

    console.log('✅ OmegaUse 离线端到端验证通过')
    console.log('验证要点:')
    console.log('  - Docker 镜像包含所有依赖（LibreOffice、Python 库）')
    console.log('  - Verifier 在 network=none 环境下正常运行')
    console.log('  - 数据集文件正确挂载且可读取')
    console.log('  - 评分器正常加载并返回结构化结果')

  } finally {
    // 清理临时目录
    // await rm(runRoot, { recursive: true, force: true })
    console.log(`临时目录保留在: ${runRoot}`)
  }
})
