import assert from 'node:assert/strict'
import test from 'node:test'

import { ProtocolError } from '../src/protocol.mjs'
import { SolverFailure } from '../src/solver-failure.mjs'
import {
  isRetryableTrialInfrastructure, validateInfrastructureRetries, withTrialInfrastructureRetries,
} from '../src/trial-infrastructure-retry.mjs'

function failure({ category = 'unknown', code = 'upstream-contract-unproven', request = {}, terminal = false } = {}) {
  return new SolverFailure({
    category, code, terminal,
    diagnostics: { complete: true, requests: [{
      origin: 'upstream', httpStatus: 200, streamError: true, ...request,
    }] },
  })
}

test('HTTP 200 流内错误最多追加 5 次重试，退避封顶并返回首次成功结果', async () => {
  const events = []
  const waits = []
  let calls = 0
  const result = await withTrialInfrastructureRetries(async () => {
    calls += 1
    if (calls <= 5) throw failure()
    return { reward: 0 }
  }, {
    maximumRetries: 5,
    beforeRetry: async (event) => events.push(event.retry),
    sleep: async (ms) => waits.push(ms),
  })
  assert.deepEqual(result, { reward: 0 })
  assert.equal(calls, 6)
  assert.deepEqual(events, [1, 2, 3, 4, 5])
  assert.deepEqual(waits, [5000, 10000, 20000, 40000, 60000])
})

test('重试耗尽保留原故障，不返回空结果或伪造零分；默认仍不重试', async () => {
  const original = failure()
  for (const maximumRetries of [0, 5]) {
    let calls = 0
    await assert.rejects(withTrialInfrastructureRetries(async () => {
      calls += 1
      throw original
    }, { maximumRetries, sleep: async () => {} }), (error) => error === original)
    assert.equal(calls, maximumRetries + 1)
  }
  let calls = 0
  await assert.rejects(withTrialInfrastructureRetries(async () => { calls += 1; throw original }))
  assert.equal(calls, 1)
})

test('只对可信上游暂态错误重试，认证、配置、Verifier、Candidate 和低分不重试', async () => {
  for (const status of [429, 500, 502, 503, 504]) {
    assert.equal(isRetryableTrialInfrastructure(failure({
      category: 'provider', code: 'upstream-unavailable', request: { httpStatus: status },
    })), true)
  }
  assert.equal(isRetryableTrialInfrastructure(failure({
    category: 'provider', code: 'upstream-stream-interrupted', request: { transportError: true },
  })), true)
  const rejected = [
    new Error('upstream error'),
    new ProtocolError('HTTP 502'),
    failure({ terminal: true, category: 'candidate' }),
    failure({ category: 'trusted-runtime', code: 'verifier-infrastructure' }),
    failure({ request: { origin: 'gateway-control', httpStatus: 429 } }),
    failure({ request: { streamError: false, done: false } }),
    ...[400, 401, 403, 404, 422].map((httpStatus) => failure({ request: { httpStatus } })),
    ...['reasoning-only-response', 'unrequested-native-tool-calls', 'no-valid-final-response']
      .map((code) => failure({ code })),
  ]
  for (const error of rejected) {
    assert.equal(isRetryableTrialInfrastructure(error), false)
    let calls = 0
    await assert.rejects(withTrialInfrastructureRetries(async () => {
      calls += 1
      throw error
    }, { maximumRetries: 5, sleep: async () => assert.fail('不应重试') }), (seen) => seen === error)
    assert.equal(calls, 1)
  }
  let calls = 0
  assert.equal(await withTrialInfrastructureRetries(async () => { calls += 1; return 0 },
    { maximumRetries: 5 }), 0)
  assert.equal(calls, 1)
})

test('非法重试预算拒绝执行；归档失败不继续做题', async () => {
  for (const value of [-1, 6, 0.5, '5', null, Infinity, NaN]) {
    assert.throws(() => validateInfrastructureRetries(value), /0 到 5/u)
  }
  await assert.rejects(withTrialInfrastructureRetries(async () => { throw failure() }, {
    maximumRetries: 5,
    beforeRetry: async () => { throw new Error('archive failed') },
    sleep: async () => assert.fail('归档失败后不应继续'),
  }), /archive failed/u)
})

test('只有显式启用且证据完整的 reasoning-only 才可重试，拒答/tool_calls/截断不放宽', () => {
  const request = { httpStatus: 200, streamError: false, transportError: false,
    responseComplete: true, done: true, finishReason: 'stop', contentBytes: 0,
    sawReasoning: true, sawRefusal: false, sawToolCalls: false, malformedEvents: 0 }
  const error = failure({ code: 'reasoning-only-response', request })
  assert.equal(isRetryableTrialInfrastructure(error), false)
  assert.equal(isRetryableTrialInfrastructure(error, { retryReasoningOnly: true }), true)
  for (const changed of [{ sawRefusal: true }, { sawToolCalls: true }, { finishReason: 'length' },
    { httpStatus: 401 }, { contentBytes: 1 }, { done: false }, { responseComplete: false }]) {
    assert.equal(isRetryableTrialInfrastructure(failure({ code: 'reasoning-only-response',
      request: { ...request, ...changed } }), { retryReasoningOnly: true }), false)
  }
})
