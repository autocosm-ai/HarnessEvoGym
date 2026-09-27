import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { loadHarborTask } from '../src/environments/harbor-task.mjs'
import { HarborEnvironment } from '../src/environments/harbor.mjs'

const digest = (value) => createHash('sha256').update(value).digest('hex')

function benchmarkFor(instanceIds, revision) {
  return {
    allInstanceIds: new Set(instanceIds),
    partitionByInstance: new Map(instanceIds.map((id) => [id, 'feedback'])),
    partitions: { feedback: { instanceIds } },
    source: { revision },
  }
}

test('Harbor Environment 为每题构建运行时并按题 Resume Checkpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harbor-environment-'))
  const tasksRoot = join(root, 'tasks')
  const candidate = join(root, 'candidate')
  const runRoot = join(root, 'run')
  const instanceIds = ['task-a', 'task-b']
  const buildCalls = []
  const copyCalls = []
  const solverCalls = []
  const verifierCalls = []
  let containerCounter = 0
  try {
    await mkdir(candidate, { recursive: true })
    await writeFile(join(candidate, 'candidate.py'), 'print("ok")\n')
    for (const id of instanceIds) {
      const taskRoot = join(tasksRoot, id)
      await mkdir(join(taskRoot, 'environment'), { recursive: true })
      await mkdir(join(taskRoot, 'tests'), { recursive: true })
      await writeFile(join(taskRoot, 'task.toml'), 'schema_version = "1.0"\nartifacts = ["/app/result.txt"]\n[metadata]\n[verifier]\nenvironment_mode = "separate"\n[agent]\n[environment]\n')
      await writeFile(join(taskRoot, 'instruction.md'), `完成 ${id}。\n`)
      await writeFile(join(taskRoot, 'environment/Dockerfile'), 'FROM scratch\n')
      await writeFile(join(taskRoot, 'tests/Dockerfile'), 'FROM scratch\n')
      await writeFile(join(taskRoot, 'tests/test.sh'), '#!/bin/sh\n')
    }
    const loaded = await Promise.all(instanceIds.map((id) => loadHarborTask(tasksRoot, id)))
    const sourceRevision = digest(loaded.sort((a, b) => a.name.localeCompare(b.name)).map((task) => `${task.name}:${task.digest}`).join('\n'))
    const environment = {
      id: 'harbor-test',
      protocol: 'harbor-task-v1',
      source: { tasksRoot: 'tasks', revision: sourceRevision },
      task: { workspacePath: '/app', maximumConcurrentTrials: 2 },
      runtime: { imagePrefix: 'harbor-test-runtime' },
      docker: { resources: { pids: 128 } },
      verifier: { resources: { cpus: 1, memory: '256m', pids: 64 } },
      feedback: { maximumTextBytesPerCase: 2048 },
      solverFailurePolicy: 'verified-candidate-terminal-v1',
    }
    const docker = {
      async info() {},
      async build(options) { buildCalls.push(options); return {} },
      async imageId(image) { return `sha256:${digest(image).padEnd(64, '0').slice(0, 64)}` },
      async create({ image, name }) { return { id: `container-${++containerCounter}`, image, name } },
      async copyFrom(container, source, destination) {
        copyCalls.push({ container, source, destination })
        await writeFile(join(destination, 'seed.txt'), 'seed\n')
      },
      async removeContainer() {},
      async run(options) {
        verifierCalls.push(options)
        const logMount = options.mounts.find((mount) => mount.target === '/logs/verifier')
        await writeFile(join(logMount.source, 'reward.txt'), '1\n')
        await writeFile(join(logMount.source, 'ctrf.json'), JSON.stringify({
          results: {
            summary: { tests: 1, passed: 1, failed: 0, skipped: 0, pending: 0, other: 0 },
            tests: [{ name: 'artifact', status: 'passed' }],
          },
        }))
      },
    }
    const solverDriver = {
      id: 'fake-solver',
      cacheKey: 'fake-v1',
      async ensureRuntime({ tag }) { return { image: `${tag}-solver` } },
      async beginUsageBatch() {},
      async endUsageBatch() {},
      async run(options) {
        solverCalls.push(options)
        await writeFile(join(options.taskWorkspace, 'result.txt'), 'answer\n')
        return { modelUsage: { complete: true, inputTokens: 3, outputTokens: 5 } }
      },
    }
    const environmentDriver = new HarborEnvironment({
      environment,
      benchmark: benchmarkFor(instanceIds, sourceRevision),
      solverDriver,
      docker,
      runRoot,
      repositoryRoot: root,
    })
    await environmentDriver.preflight()
    assert.equal((await environmentDriver.ensureRuntime()).size, 2)
    const outputPath = join(runRoot, 'results.jsonl')
    const runOptions = {
      candidateId: 'candidate-a',
      candidateDigest: 'a'.repeat(64),
      candidateWorkspace: candidate,
      model: { provider: 'test', model: 'test-model', maxTokens: 128, reasoningEffort: 'low' },
      partition: 'feedback',
      seeds: [1, 2],
      outputPath,
      maximumConcurrentTrials: 2,
    }
    const first = await environmentDriver.runCandidatePartition(runOptions)
    assert.equal(first.size, 2)
    assert.equal(solverCalls.length, 4)
    assert.equal(verifierCalls.length, 4)
    assert.equal(copyCalls.length, 4)
    assert.equal(buildCalls.filter((call) => call.dockerfile.endsWith('environment/Dockerfile')).length, 2)
    assert.match(JSON.parse((await readFile(outputPath, 'utf8')).split('\n')[0]).feedback.ctrf, /tests=1/u)
    const outputBeforeResume = (await readFile(outputPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    await environmentDriver.runCandidatePartition(runOptions)
    assert.equal(solverCalls.length, 4, '第二次运行应复用已提交的题目 checkpoint')
    assert.equal(verifierCalls.length, 4, '第二次运行不应重复评分')
    const outputAfterResume = (await readFile(outputPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    assert.deepEqual(
      outputAfterResume.map(({ instance_id: instanceId, reward, trial_seeds: trialSeeds }) => ({ instanceId, reward, trialSeeds })),
      outputBeforeResume.map(({ instance_id: instanceId, reward, trial_seeds: trialSeeds }) => ({ instanceId, reward, trialSeeds })),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
