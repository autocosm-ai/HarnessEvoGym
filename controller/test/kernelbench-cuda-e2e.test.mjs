import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { prepareKernelBench } from '../../scripts/prepare-kernelbench.mjs'
import { REPOSITORY_ROOT, readConfigFile } from '../src/config.mjs'
import { validateEnvironmentAdapter } from '../src/adapters.mjs'
import { validateBenchmark } from '../src/protocol.mjs'
import { createEnvironmentRunner } from '../src/factories.mjs'
import { DockerClient } from '../src/docker.mjs'

test('原始 KernelBench：NVCC 编译、三分区、多 seed、错误零分及新进程实例恢复', {
  skip: process.env.RSI_RUN_KERNELBENCH_CUDA_E2E !== '1', timeout: 15 * 60 * 1000,
}, async () => {
  await mkdir(join(REPOSITORY_ROOT, '.rsi'), { recursive: true })
  const root = await mkdtemp(join(REPOSITORY_ROOT, '.rsi/kernelbench-cuda-e2e-'))
  let completed = false
  try {
    const prepared = await prepareKernelBench({ sourceRoot: join(REPOSITORY_ROOT, 'ref-code/KernelBench'), outputRoot: join(root, 'suite') })
    const environment = validateEnvironmentAdapter(await readConfigFile(join(prepared.root, 'environment.json')))
    const benchmark = validateBenchmark(await readConfigFile(join(prepared.root, 'benchmark.json')))
    const cudaSource = await readFile(join(REPOSITORY_ROOT, 'controller/test/fixtures/kernelbench-cuda-matmul.py'), 'utf8')
    const candidateWorkspace = join(root, 'candidate')
    await mkdir(candidateWorkspace)
    await writeFile(join(candidateWorkspace, 'identity.txt'), 'deterministic-gpu-fixture')
    let calls = 0
    let incorrect = false
    const solverDriver = {
      cacheKey: 'kernelbench-native-fixture-v1',
      async ensureRuntime({ baseImage, baseImageIdentity }) { return { image: baseImage, imageIdentity: baseImageIdentity } },
      async run({ taskWorkspace, task }) {
        calls += 1
        if (incorrect) await writeFile(join(taskWorkspace, 'model_new.py'), 'from reference import Model\nclass ModelNew(Model):\n def forward(self,*args):\n  return super().forward(*args)*0\n')
        else if (task.includes('1_Square_')) await writeFile(join(taskWorkspace, 'model_new.py'), cudaSource)
        return { modelUsage: { complete: true, inputTokens: 0, outputTokens: 0 } }
      },
    }
    const docker = new DockerClient(environment.docker)
    const createRunner = () => createEnvironmentRunner({ repositoryRoot: REPOSITORY_ROOT, environment, benchmark,
      target: {}, solverDriver, docker, runRoot: join(root, 'run') })
    const runner = createRunner()
    await runner.preflight()
    const base = { candidateId: 'compiled', candidateDigest: 'a'.repeat(64), candidateWorkspace,
      model: { provider: 'offline-fixture', model: 'offline-fixture', maxTokens: 1 }, seeds: [7, 19] }
    const evidence = []
    for (const partition of ['feedback', 'selection', 'final']) {
      const result = await runner.runCandidatePartition({ ...base, partition, allowSealed: partition === 'final',
        outputPath: join(root, 'run', `${partition}.jsonl`) })
      const record = [...result.values()][0]
      assert.equal(record.status, 'resolved', await readFile(join(root, 'run', `${partition}.jsonl`), 'utf8'))
      assert.ok(record.reward > 0 && record.reward < 1)
      evidence.push({ task: record.instanceId, reward: record.reward, seeds: record.trialSeeds })
      if (partition === 'feedback') {
        const raw = JSON.parse((await readFile(join(root, 'run/feedback.jsonl'), 'utf8')).trim())
        assert.match(raw.feedback.verifierFeedback, /METRIC correctness_trials=3/u)
        assert.match(raw.feedback.verifierFeedback, /METRIC timing_rounds=5/u)
      }
    }
    assert.equal(calls, 6)
    const resumed = createRunner()
    await resumed.preflight()
    await resumed.runCandidatePartition({ ...base, partition: 'feedback', outputPath: join(root, 'run/feedback.jsonl') })
    assert.equal(calls, 6, '新实例不得重跑已提交结果')
    incorrect = true
    const wrong = await runner.runCandidatePartition({ ...base, candidateId: 'wrong', candidateDigest: 'b'.repeat(64),
      partition: 'feedback', seeds: [7], outputPath: join(root, 'run/wrong.jsonl') })
    assert.equal([...wrong.values()][0].reward, 0)
    assert.equal(calls, 7, '数值错误只能记零分，不得按基础设施故障反复重试')
    console.log(JSON.stringify({ kind: 'KernelBenchCudaAcceptance', source: prepared.revision,
      compiledCuda: true, solver: 'deterministic-fixture', modelCalls: 0, trials: 7, resumeReused: true, evidence }))
    completed = true
  } finally {
    if (completed) await rm(root, { recursive: true, force: true })
    else console.error(`GPU 失败证据保留在：${root}`)
  }
})
