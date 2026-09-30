import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readConfigFile } from '../src/config.mjs'
import { validateEnvironmentAdapter } from '../src/adapters.mjs'
import { validateBenchmark } from '../src/protocol.mjs'
import { createEnvironmentRunner } from '../src/factories.mjs'
import { DockerClient } from '../src/docker.mjs'

const enabled = process.env.RSI_RUN_KERNELBENCH_DOCKER_E2E === '1'

test('KernelBench GPU Smoke：两道题经过 Solver、GPU Verifier 与 Checkpoint', { skip: !enabled }, async () => {
  const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
  const environment = validateEnvironmentAdapter(
    await readConfigFile(join(repositoryRoot, 'environments/kernelbench-gpu.yml')),
  )
  const benchmark = validateBenchmark(
    await readConfigFile(join(repositoryRoot, 'benchmarks/kernelbench-smoke-v1/benchmark.json')),
  )
  const runRoot = await mkdtemp(join(tmpdir(), 'kernelbench-gpu-e2e-'))
  const candidateWorkspace = join(runRoot, 'candidate')
  await mkdir(candidateWorkspace, { recursive: true })
  await writeFile(join(candidateWorkspace, 'candidate.txt'), 'mock Solver candidate\n')
  const docker = new DockerClient({
    binary: 'docker',
    network: 'none',
    resources: { cpus: 4, memory: '16g', pids: 1024, timeoutSeconds: 1800, gpus: 1 },
  })
  const solverDriver = {
    cacheKey: 'kernelbench-smoke-noop-solver',
    async ensureRuntime({ baseImage, baseImageIdentity }) {
      return { image: baseImage, imageIdentity: baseImageIdentity }
    },
    async run({ taskWorkspace }) {
      // 真实 MSA Solver 接入由 Experiment 配置负责；这里只验证 Environment 的
      // Docker/Verifier/Checkpoint 链路，不向 Provider 发请求。
      return { modelUsage: { complete: false }, taskWorkspace }
    },
  }
  const runner = createEnvironmentRunner({
    repositoryRoot,
    environment,
    benchmark,
    target: {},
    solverDriver,
    docker,
    runRoot,
  })
  try {
    await runner.preflight()
    await runner.ensureRuntime()
    for (const [partition, instanceId] of [['feedback', 'relu'], ['selection', 'sigmoid']]) {
      const outputPath = join(runRoot, 'results', `${partition}.jsonl`)
      const results = await runner.runCandidatePartition({
        candidateId: 'h0',
        candidateDigest: '0'.repeat(64),
        candidateWorkspace,
        model: { provider: 'test', model: 'mock', maxTokens: 1, reasoningEffort: null },
        partition,
        seeds: [1],
        outputPath,
      })
      const record = [...results.values()][0]
      assert.equal(record.instanceId, instanceId)
      assert.ok(record.reward >= 0 && record.reward <= 1)
      assert.match(await readFile(outputPath, 'utf8'), new RegExp(`"instance_id":"${instanceId}"`, 'u'))
    }
  } finally {
    await rm(runRoot, { recursive: true, force: true })
  }
})
