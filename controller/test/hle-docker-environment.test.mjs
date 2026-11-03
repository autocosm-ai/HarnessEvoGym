import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readConfigFile, REPOSITORY_ROOT } from '../src/config.mjs'
import { validateEnvironmentAdapter } from '../src/adapters.mjs'
import { validateBenchmark } from '../src/protocol.mjs'
import { HleTextMathEnvironment } from '../src/environments/hle-text-math.mjs'
import { HleJudgeInfrastructureError } from '../src/hle-partition-runner.mjs'

test('HLE 真实环境适配逻辑：Judge 失败不算零分，重建进程状态后保留已完成题与多 seed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gym-hle-docker-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const config = await readConfigFile(join(REPOSITORY_ROOT, 'environments/text-reasoning-smoke.yml'))
  const raw = await readConfigFile(join(REPOSITORY_ROOT, 'benchmarks/text-reasoning-smoke/benchmark.json'))
  raw.spec.partitions.feedback.instanceIds = ['a', 'b']; raw.spec.partitions.feedback.expectedCount = 2
  for (const p of ['selection', 'final']) { raw.spec.partitions[p].instanceIds = []; raw.spec.partitions[p].expectedCount = 0 }
  raw.spec.expectedTotal = 2; raw.spec.finalEvaluation = 'disabled'
  const content = JSON.stringify({ apiVersion: 'harness-rsi/v1alpha1', kind: 'HleTextMathTasks',
    metadata: { id: 'hle-offline-fixture', notice: '合成题，只验证 HLE 执行契约，不报告 HLE 能力。' },
    instances: ['a', 'b'].map((id) => ({ id, partition: 'feedback', instruction: id, answer: 'gold-not-visible-to-solver' })) })
  await writeFile(join(root, 'tasks.json'), content)
  const revision = createHash('sha256').update(content).digest('hex')
  raw.spec.source.revision = revision
  config.spec.protocol = 'hle-text-math-docker-v1'
  config.spec.source = { tasksPath: 'tasks.json', digest: revision }
  config.spec.judge = { model: 'fixture-judge', reasoningEffort: 'medium', maxTokens: 1024, timeoutSeconds: 30 }
  const environment = validateEnvironmentAdapter(config), benchmark = validateBenchmark(raw)
  const calls = []; let fail = true
  const solverDriver = { async ensureRuntime() { return { image: 'fixture-image' } },
    async run({ task }) {
      assert.doesNotMatch(task, /gold-not-visible/u)
      calls.push(task)
      return { answer: task, durationMs: 1, modelUsage: { complete: true, inputTokens: 2, outputTokens: 3 } }
    } }
  const create = () => new HleTextMathEnvironment({ repositoryRoot: root, environment, benchmark, solverDriver, runRoot: join(root, 'run'),
    docker: { async info() {}, async imageExists() { return true }, async imageId() { return 'sha256:fixture' } },
    judge: async ({ response }) => {
      if (response === 'b' && fail) throw new HleJudgeInfrastructureError('JUDGE_UPSTREAM_REJECTED')
      return { correct: response === 'b', usage: { inputTokens: 1, outputTokens: 1 } }
    } })
  const candidate = join(root, 'candidate'); await mkdir(candidate)
  await writeFile(join(candidate, 'run.py'), 'print(1)\n')
  const options = { candidateId: 'h0', candidateDigest: 'a'.repeat(64), candidateWorkspace: candidate,
    model: { model: 'fixture-solver', maxTokens: 128, reasoningEffort: 'medium' }, seeds: [1, 2],
    partition: 'feedback', outputPath: join(root, 'run/results.jsonl') }
  const first = create(); await first.preflight()
  await assert.rejects(first.runCandidatePartition(options), (error) => error.failure?.code === 'verifier-infrastructure')
  await assert.rejects(readFile(options.outputPath), { code: 'ENOENT' })
  assert.deepEqual(calls, ['a', 'a', 'b'])
  fail = false
  const second = create(); await second.preflight()
  const result = await second.runCandidatePartition(options)
  assert.deepEqual(calls, ['a', 'a', 'b', 'b', 'b'])
  assert.equal(result.get('a').reward, 0)
  assert.equal(result.get('b').reward, 1)
  assert.deepEqual(result.get('b').trialSeeds, [1, 2])
  assert.equal(second.describeCapabilities().supportsCheckpointResume, true)
})
