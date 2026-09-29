import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compareEvaluationIdentity,
  createEvaluationIdentity,
  normalizeEvaluationMode,
  validateEvaluationIdentity,
} from '../src/evaluation-profile.mjs'

function identity(overrides = {}) {
  return createEvaluationIdentity({
    mode: 'resume',
    runId: 'run-001',
    evaluation: {
      benchmark: 'officeval-v1',
      model: 'gpt-5.6-terra',
      provider: 'zcloud',
      steps: 16,
    },
    ...overrides,
  })
}

test('评测模式只允许四种明确语义', () => {
  assert.equal(normalizeEvaluationMode(), 'resume')
  assert.equal(normalizeEvaluationMode('sealed-final'), 'sealed-final')
  assert.throws(() => normalizeEvaluationMode('anything'), /评测模式必须是/u)
})

test('resume 身份相同可以复用已提交结果', () => {
  const value = identity()
  assert.deepEqual(compareEvaluationIdentity(value, value), {
    compatible: true,
    reuse: 'committed',
    changedFields: [],
  })
  assert.deepEqual(validateEvaluationIdentity(value), value)
})

test('resume 和 sealed-final 拒绝配置漂移', () => {
  const previous = identity()
  const current = identity({ evaluation: { ...previous.evaluation, timeoutSeconds: 7200 } })
  assert.throws(
    () => compareEvaluationIdentity(previous, current),
    (error) => error.code === 'RSI_RESUME_INCOMPATIBLE' && error.details.includes('evaluation.timeoutSeconds'),
  )
  const sealed = identity({ mode: 'sealed-final' })
  const changedSealed = identity({ mode: 'sealed-final', evaluation: { ...sealed.evaluation, seed: 2 } })
  assert.throws(() => compareEvaluationIdentity(sealed, changedSealed), /评测身份发生变化/u)
})

test('fork 需要父 Run，并把旧结果标记为 stale 而不是复用', () => {
  assert.throws(
    () => identity({ mode: 'fork' }),
    /fork 模式必须记录 parentRunId/u,
  )
  const previous = identity()
  const fork = identity({ mode: 'fork', runId: 'run-002', parentRunId: previous.runId, evaluation: { ...previous.evaluation, timeoutSeconds: 7200 } })
  const comparison = compareEvaluationIdentity(previous, fork, { mode: 'fork' })
  assert.equal(comparison.compatible, false)
  assert.equal(comparison.reuse, 'stale')
  assert.ok(comparison.changedFields.includes('runId'))
})

test('探索性评测允许配置变化但不冒充正式结果', () => {
  const previous = identity()
  const exploratory = identity({ mode: 'exploratory', runId: 'run-003', evaluation: { ...previous.evaluation, model: 'claude-sonnet-5' } })
  const comparison = compareEvaluationIdentity(previous, exploratory)
  assert.equal(comparison.compatible, false)
  assert.equal(comparison.reuse, 'stale')
  assert.match(comparison.reason, /探索性评测/u)
})

test('评测身份不允许写入 API Key 等凭据', () => {
  assert.throws(
    () => identity({ evaluation: { api_key: 'should-not-be-here' } }),
    /禁止写入密钥或凭据/u,
  )
  const value = identity({ evaluation: { maxOutputTokens: 8192 } })
  assert.equal(value.evaluation.maxOutputTokens, 8192)
})

