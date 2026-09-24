import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertSharedFinalCompatibility, executeSharedFinalJobs, validateSharedFinalConfig } from '../src/shared-final-suite.mjs'
import { reserveFinalTrialAttempt, saveSuiteJson, readOptionalJson } from '../src/final-suite-store.mjs'
import { writeJsonLines } from '../src/candidate.mjs'
import { validateBenchmark } from '../src/protocol.mjs'

test('共享 H0 配置拒绝重复模式、越界重试和不存在的 Baseline 来源', () => {
  const base = { id: 'test-suite', baselineFrom: 'single', populations: [{ label: 'single', run: '/single' }] }
  assert.equal(validateSharedFinalConfig(base).infrastructureRetries, 5)
  for (const extra of [{ baselineFrom: 'combined' }, { infrastructureRetries: 11 }, { retryReasoningOnly: 'yes' },
    { populations: [...base.populations, ...base.populations] }, { extra: 1 }]) {
    assert.throws(() => validateSharedFinalConfig({ ...base, ...extra }))
  }
})

test('共享 H0 必须固定相同题目、H0、模型与环境，不比较 Mode 名称', () => {
  const baseline = { label: 'single', compatibility: { h0: 'a', model: 'terra', seeds: [1], steps: 12 } }
  assert.doesNotThrow(() => assertSharedFinalCompatibility([baseline, { ...baseline, label: 'combined' }]))
  for (const changed of [{ h0: 'b' }, { model: 'sol' }, { seeds: [2] }, { steps: 6 }]) {
    assert.throws(() => assertSharedFinalCompatibility([baseline,
      { label: 'combined', compatibility: { ...baseline.compatibility, ...changed } }]), /共享 H0/u)
  }
})

test('不可变 Claim 幂等且拒绝换身份；题目重试预算跨调用不清零', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'shared-final-store-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'claim.json')
  await saveSuiteJson(path, { id: 1 }, { immutable: true })
  await saveSuiteJson(path, { id: 1 }, { immutable: true })
  await assert.rejects(saveSuiteJson(path, { id: 2 }, { immutable: true }), /不可变/u)
  const budget = join(root, 'budget.json')
  for (let i = 0; i < 6; i++) await reserveFinalTrialAttempt(budget, { candidate: 'frozen' }, 6)
  await assert.rejects(reserveFinalTrialAttempt(budget, { candidate: 'frozen' }, 6), /耗尽/u)
  await assert.rejects(reserveFinalTrialAttempt(budget, { candidate: 'changed' }, 6), /身份/u)
})

function benchmark() {
  return validateBenchmark({ apiVersion: 'harness-rsi/v1alpha1', kind: 'Benchmark',
    metadata: { id: 'test-shared', name: 'shared final' },
    spec: { source: { adapter: 'fixture', dataset: 'fixture', split: 'fixture', revision: 'fixed' },
      evaluator: { adapter: 'fixture', resultFormat: 'harness-rsi/solver-result-jsonl-v1' }, expectedTotal: 3,
      partitions: { feedback: { visibility: 'detailed', instanceIds: ['train'] },
        selection: { visibility: 'aggregate-only', instanceIds: ['selection'] },
        final: { visibility: 'sealed', instanceIds: ['hidden'] } } } })
}

test('六份评测只调用一次 H0、五次冠军；零分保留，Resume 不调用模型', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'shared-final-jobs-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const calls = []
  const jobs = ['h0', 'single', 'independent', 'mutualism', 'competition', 'combined'].map((label) => ({
    label, benchmark: benchmark(), candidate: { candidateId: label, candidateDigest: 'a'.repeat(64) },
    outputPath: join(root, 'results', `${label}.jsonl`), model: { model: 'unchanged' }, seeds: [1],
    stop: async () => {}, environment: { async runCandidatePartition(input) {
      calls.push(input)
      const record = { instance_id: 'hidden', status: 'unresolved', reward: 0,
        cost_usd: 0, wall_time_ms: 1, trials: 1 }
      await writeJsonLines(input.outputPath, [record])
      return new Map([['hidden', record]])
    } },
  }))
  const config = { infrastructureRetries: 5, retryReasoningOnly: true }
  let records = await executeSharedFinalJobs({ root, jobs, config })
  assert.equal(records.size, 6)
  assert.equal(calls.filter((c) => c.candidateId === 'h0').length, 1)
  assert.ok(calls.every((c) => c.partition === 'final' && c.strictFinalCheckpoints && c.retryReasoningOnly))
  assert.equal(records.get('single').get('hidden').reward, 0)
  records = await executeSharedFinalJobs({ root, jobs, config })
  assert.equal(records.size, 6)
  assert.equal(calls.length, 6)
  await rm(jobs[0].outputPath)
  records = await executeSharedFinalJobs({ root, jobs, config })
  assert.equal(records.has('h0'), false)
  assert.equal(calls.length, 6, '已完成文件丢失必须失败，不能重新抽样')
})

test('某个冠军失败不阻塞其他冠军；缺题不生成完整得分', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'shared-final-partial-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const jobs = ['h0', 'single'].map((label) => ({ label, benchmark: benchmark(),
    candidate: { candidateId: label, candidateDigest: 'a'.repeat(64) },
    outputPath: join(root, `${label}.jsonl`), model: {}, seeds: [1], stop: async () => {},
    environment: { async runCandidatePartition() { return new Map() } },
  }))
  const records = await executeSharedFinalJobs({ root, jobs, config: { infrastructureRetries: 5, retryReasoningOnly: false } })
  assert.equal(records.size, 0)
  assert.equal((await readOptionalJson(join(root, 'jobs/h0.json'))).status, 'failed')
})
