import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { runFinalEvaluationPartitions, finalEvaluationPolicy } from '../src/final-evaluation-partitions.mjs'
import { SolverFailure } from '../src/solver-failure.mjs'
import { runtimeFixture, failingRun } from './fixtures/solver-failure-runtime.mjs'

async function finalFixture(t, cases) {
  const fixture = await runtimeFixture(t, { cases })
  // 明确标记的本地 fixture：沿用真实 H0 model.py，解题任务/评分器与 Docker 使用替身。
  await writeFile(join(fixture.candidate, 'run.py'), failingRun.replace('answer = json.loads(text)', 'answer = text'))
  const ids = fixture.benchmark.partitions.feedback.instanceIds
  fixture.benchmark.partitions.final.instanceIds = ids
  fixture.benchmark.partitions.feedback.instanceIds = []
  fixture.benchmark.partitionByInstance = new Map(ids.map((id) => [id, 'final']))
  const runRoot = join(fixture.root, 'run')
  const waits = []
  const environment = fixture.environmentFactory({
    repositoryRoot: fixture.root, runRoot, retrySleep: async (ms) => waits.push(ms),
  })
  await environment.preflight()
  const options = {
    candidateId: 'h0', candidateDigest: 'a'.repeat(64), candidateWorkspace: fixture.candidate,
    model: fixture.bundle.experiment.models.solver, partition: 'final', seeds: [1],
    outputPath: join(runRoot, 'h0-final-fixed-claim.jsonl'), infrastructureRetries: 5,
  }
  return { fixture, environment, options, runRoot, waits }
}

test('Final HTTP200 流内 error → 只重试失败题 → 真实 MSA 请求恢复；合法零分和冻结 model.py 不变', async (t) => {
  const { fixture, environment, options, runRoot, waits } = await finalFixture(t, ['valid', 'streamerror'])
  const before = await readFile(join(fixture.candidate, 'model.py'))
  const verifier = environment.runVerifier.bind(environment)
  environment.runVerifier = async (input) => {
    const result = await verifier(input)
    return input.layout.instanceId === 'officeval_001' ? { ...result, total_score: 0 } : result
  }
  const events = []
  const result = await runFinalEvaluationPartitions({
    environment,
    baseline: { candidateId: 'h0', candidateDigest: options.candidateDigest, candidateWorkspace: fixture.candidate },
    candidate: { candidateId: 'h0', candidateDigest: options.candidateDigest, candidateWorkspace: fixture.candidate },
    model: options.model, seeds: options.seeds,
    outputPath: () => options.outputPath,
    policy: finalEvaluationPolicy({ finalOnly: true }),
    onEvent: (event) => {
      events.push(event)
      if (event.stage === 'final-retry') fixture.modes.set('streamerror', 'valid')
    },
  })
  assert.equal(result.baselineRecords.size, 2)
  assert.equal(result.baselineRecords.get('officeval_001').reward, 0)
  assert.equal(result.baselineRecords.get('officeval_002').reward, 0.5)
  assert.equal(fixture.verifierCalls(), 2)
  // 失败的 streamerror 题每次尝试打 2 次网关请求：H0 model.py 首次失败后睡 5 秒再重发，
  // 第二次失败要睡 10 秒，但 fixture 的 10 秒进程超时先到期，进程被 kill 并交还 Controller。
  // 因此 2 次（失败尝试）+ 1 次（Controller 重试后成功）+ 1 次（另一题）= 4。
  assert.equal(fixture.gateway.observed.length, 4)
  assert.equal(fixture.driver.usage().requests, 4)
  assert.deepEqual(waits, [5000])
  assert.deepEqual(await readFile(join(fixture.candidate, 'model.py')), before)
  assert.doesNotMatch(JSON.stringify(events), /officeval_|fixture_unavailable/u)
  const archives = await readdir(join(runRoot, 'recovery/trial-attempts'), { recursive: true })
  assert.ok(archives.some((path) => path.endsWith('solver-failure.json')))
  assert.ok(archives.some((path) => path.endsWith('recovery.json')))
  // 同一 Attempt 的已完成结果（包括 0 分）都复用，不再次调用模型或 Verifier。
  await environment.runCandidatePartition(options)
  assert.equal(fixture.gateway.observed.length, 4)
  assert.equal(fixture.verifierCalls(), 2)
})

test('Final 重试 5 次仍失败：保留已完成题和失败证据，不生成最终分数', async (t) => {
  const { fixture, environment, options, runRoot } = await finalFixture(t, ['valid', 'streamerror'])
  await assert.rejects(environment.runCandidatePartition(options), (error) => error instanceof SolverFailure
    && error.failure.code === 'upstream-contract-unproven')
  // 失败的 streamerror 题打满 6 次尝试（budget 5 + 首次），每次 2 请求 = 12；另一题 1 次成功请求。
  assert.equal(fixture.gateway.observed.filter((entry) => entry.mode === 'streamerror').length, 12)
  assert.equal(fixture.verifierCalls(), 1)
  assert.equal(fixture.driver.usage().requests, 13)
  await assert.rejects(readFile(options.outputPath), { code: 'ENOENT' })
  const executionId = createHash('sha256').update(options.outputPath).digest('hex').slice(0, 12)
  const task = join(runRoot, 'trials', executionId, 'h0/final/officeval_001')
  assert.equal(JSON.parse(await readFile(join(task, 'committed-result.json'), 'utf8')).kind, 'TaskTrialCheckpoint')
})

test('Final 暂态 429 与真实连接中断恢复后可继续评分', async (t) => {
  for (const mode of ['http429', 'interrupt']) {
    await t.test(mode, async (child) => {
      const { fixture, environment, options, waits } = await finalFixture(child, [mode])
      const records = await environment.runCandidatePartition({
        ...options,
        onInfrastructureRetry: () => fixture.modes.set(mode, 'valid'),
      })
      assert.equal(records.size, 1)
      // 首次尝试被超时截断前打了 2 次请求（5 秒退避后重发，第二次的 10 秒退避未走完即被 kill），
      // Controller 重试后成功再 1 次。
      assert.equal(fixture.gateway.observed.length, 3)
      assert.equal(fixture.verifierCalls(), 1)
      assert.deepEqual(waits, [5000])
    })
  }
})

test('Final 401、tool_calls 与 Verifier 故障不盲目重做题', async (t) => {
  for (const mode of ['http401', 'tools', 'verifier']) {
    await t.test(mode, async (child) => {
      const { fixture, environment, options, waits } = await finalFixture(child, [mode === 'verifier' ? 'valid' : mode])
      if (mode === 'verifier') environment.runVerifier = async () => { throw new Error('fixture verifier failure') }
      await assert.rejects(environment.runCandidatePartition(options), (error) => error instanceof SolverFailure)
      assert.equal(fixture.gateway.observed.length, 1)
      assert.deepEqual(waits, [])
      await assert.rejects(readFile(options.outputPath), { code: 'ENOENT' })
    })
  }
})

test('共享 Final 空正文兼容经过真实网关和 MSA；重启 Environment 仍复用已完成题', async (t) => {
  const { fixture, environment, options, runRoot } = await finalFixture(t, ['valid', 'reasoning'])
  const selected = { ...options, retryReasoningOnly: true, strictFinalCheckpoints: true,
    onInfrastructureRetry: () => fixture.modes.set('reasoning', 'valid') }
  const before = await readFile(join(fixture.candidate, 'model.py'))
  const records = await environment.runCandidatePartition(selected)
  assert.equal(records.size, 2)
  // H0 model.py 对空正文已有三次请求尝试，Controller 再整题重试一次。
  assert.equal(fixture.gateway.observed.length, 5)
  const restored = fixture.environmentFactory({ repositoryRoot: fixture.root, runRoot, retrySleep: async () => {} })
  await restored.preflight()
  await restored.runCandidatePartition(selected)
  assert.equal(fixture.gateway.observed.length, 5)
  assert.deepEqual(await readFile(join(fixture.candidate, 'model.py')), before)
  await assert.rejects(restored.runCandidatePartition({ ...selected, model: { ...selected.model, maxTokens: 1234 } }),
    /身份发生变化/u)
  assert.equal(fixture.gateway.observed.length, 5)
})

test('共享 Final 持久化重试预算防止 Resume 清零，已完成题不重新评分', async (t) => {
  const { fixture, environment, options, runRoot } = await finalFixture(t, ['valid', 'streamerror'])
  const selected = { ...options, strictFinalCheckpoints: true, retryReasoningOnly: true }
  await assert.rejects(environment.runCandidatePartition(selected))
  assert.equal(fixture.gateway.observed.length, 13)
  const restored = fixture.environmentFactory({ repositoryRoot: fixture.root, runRoot, retrySleep: async () => {} })
  await restored.preflight()
  await assert.rejects(restored.runCandidatePartition(selected), /重试预算已耗尽/u)
  assert.equal(fixture.gateway.observed.length, 13)
  assert.equal(fixture.verifierCalls(), 1)
})
