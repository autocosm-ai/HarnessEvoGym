import assert from 'node:assert/strict'
import test from 'node:test'

import { finalEvaluationPolicy, runFinalEvaluationPartitions } from '../src/final-evaluation-partitions.mjs'

function fixture() {
  const calls = []
  const events = []
  const options = {
    environment: { async runCandidatePartition(input) {
      calls.push(input)
      await input.onInfrastructureRetry({ retry: 1, maximumRetries: 5, delayMs: 5000, taskId: 'secret-final-id' })
      return new Map([[`${input.partition}-task`, { reward: input.candidateId === 'h0' ? 0 : 0.5 }]])
    } },
    baseline: { candidateId: 'h0', candidateDigest: 'a'.repeat(64), candidateWorkspace: '/frozen/h0' },
    candidate: { candidateId: 'g016', candidateDigest: 'b'.repeat(64), candidateWorkspace: '/frozen/g016' },
    model: { provider: 'unchanged', model: 'unchanged', maxTokens: 8192, reasoningEffort: 'xhigh' },
    seeds: [27],
    outputPath: (candidateId, partition) => `/private/${candidateId}-${partition}-fixed-attempt.jsonl`,
    onEvent: (event) => events.push(event),
  }
  return { calls, events, options }
}

test('只测 Final 不触碰训练题，保持 H0/Champion/模型/Seed 原值并传递重试策略', async () => {
  const { calls, events, options } = fixture()
  const policy = finalEvaluationPolicy({ finalOnly: true })
  const result = await runFinalEvaluationPartitions({ ...options, policy })
  assert.deepEqual(calls.map((c) => [c.candidateId, c.partition]), [['h0', 'final'], ['g016', 'final']])
  assert.deepEqual([...result.baselineRecords.keys()], ['final-task'])
  assert.equal(result.baselineRecords.get('final-task').reward, 0)
  assert.equal(result.candidateRecords.get('final-task').reward, 0.5)
  for (const call of calls) {
    assert.equal(call.model, options.model)
    assert.equal(call.seeds, options.seeds)
    assert.equal(call.infrastructureRetries, 5)
    assert.equal(call.outputPath, options.outputPath(call.candidateId, 'final'))
    const candidate = call.candidateId === 'h0' ? options.baseline : options.candidate
    assert.equal(call.candidateDigest, candidate.candidateDigest)
    assert.equal(call.candidateWorkspace, candidate.candidateWorkspace)
  }
  assert.equal(JSON.stringify(events).includes('secret-final-id'), false)
})

test('旧 Final 默认保留 feedback + final 四步；Champion 为 H0 时不重复评测', async () => {
  const { calls, options } = fixture()
  const result = await runFinalEvaluationPartitions({ ...options, policy: finalEvaluationPolicy() })
  assert.deepEqual(calls.map((c) => [c.candidateId, c.partition]), [
    ['h0', 'feedback'], ['g016', 'feedback'], ['h0', 'final'], ['g016', 'final'],
  ])
  assert.equal(result.baselineRecords.size, 2)
  calls.length = 0
  await runFinalEvaluationPartitions({
    ...options, candidate: options.baseline, policy: finalEvaluationPolicy({ infrastructureRetries: 0 }),
  })
  assert.deepEqual(calls.map((c) => [c.candidateId, c.partition]), [['h0', 'feedback'], ['h0', 'final']])
  assert.ok(calls.every((c) => c.infrastructureRetries === 0))
})

test('Final 参数在领取 Claim/访问题目之前校验；基础设施失败不产生不完整报告', async () => {
  assert.throws(() => finalEvaluationPolicy({ finalOnly: 'yes' }), /布尔值/u)
  assert.throws(() => finalEvaluationPolicy({ infrastructureRetries: 11 }), /0 到 10/u)
  const { calls, options } = fixture()
  options.environment.runCandidatePartition = async (input) => {
    calls.push(input)
    throw new Error('infrastructure exhausted')
  }
  await assert.rejects(runFinalEvaluationPartitions({ ...options, policy: finalEvaluationPolicy({ finalOnly: true }) }),
    /infrastructure exhausted/u)
  assert.equal(calls.length, 1)
})
