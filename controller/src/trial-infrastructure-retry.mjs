import { setTimeout as delay } from 'node:timers/promises'

import { ProtocolError } from './protocol.mjs'
import { SolverFailure } from './solver-failure.mjs'

export const MAXIMUM_FINAL_INFRASTRUCTURE_RETRIES = 5

export function validateInfrastructureRetries(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAXIMUM_FINAL_INFRASTRUCTURE_RETRIES) {
    throw new ProtocolError('infrastructureRetries 必须是 0 到 5 的整数')
  }
  return value
}

// 只重试可信观测证明的请求故障；分数、模型正文和 Candidate 自报错误不参与判断。
export function isRetryableTrialInfrastructure(error) {
  if (!(error instanceof SolverFailure) || error.failure?.terminal !== false) return false
  const { category, code, diagnostics } = error.failure
  const request = diagnostics?.requests?.at(-1)
  if (!request || request.origin !== 'upstream') return false
  if ([400, 401, 403, 404, 422].includes(request.httpStatus)) return false
  if (category === 'provider') {
    return ['upstream-stream-interrupted', 'upstream-unavailable'].includes(code)
      && (request.transportError === true || [429, 500, 502, 503, 504].includes(request.httpStatus))
  }
  // 兼容旧网关把 HTTP 200 内的 error 帧标成 unknown 的记录。不把正常空回答、
  // length/tool_calls、拒答、Verifier 失败或任意 ProtocolError 当成可重试故障。
  return category === 'unknown' && code === 'upstream-contract-unproven'
    && request.httpStatus === 200
    && (request.streamError === true || request.transportError === true)
}

export async function withTrialInfrastructureRetries(operation, {
  maximumRetries = 0,
  beforeRetry = async () => {},
  sleep = delay,
} = {}) {
  validateInfrastructureRetries(maximumRetries)
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (attempt >= maximumRetries || !isRetryableTrialInfrastructure(error)) throw error
      const retry = attempt + 1
      const delayMs = Math.min(60_000, 5_000 * (2 ** attempt))
      // 先归档半成品，失败时保留原始错误；不触碰其他题已提交的断点。
      await beforeRetry({ error, retry, maximumRetries, delayMs })
      await sleep(delayMs)
    }
  }
}
