import { setTimeout as delay } from 'node:timers/promises'
import { StreamWatch } from '../../docker/model-gateway/stream-watch.mjs'
import { ProtocolError } from './protocol.mjs'

export function updaterSupervision(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((key) => !['maximumRetries', 'idleTimeoutSeconds', 'retryDelayMs'].includes(key))) {
    throw new ProtocolError('Updater supervision 配置无效')
  }
  const result = { maximumRetries: 2, idleTimeoutSeconds: 600, retryDelayMs: 1000, ...value }
  for (const [key, minimum, maximum] of [['maximumRetries', 0, 5], ['idleTimeoutSeconds', 30, 3600], ['retryDelayMs', 0, 60_000]]) {
    if (!Number.isSafeInteger(result[key]) || result[key] < minimum || result[key] > maximum) {
      throw new ProtocolError(`Updater supervision.${key} 必须位于 ${minimum}..${maximum}`)
    }
  }
  return Object.freeze(result)
}

export class UpdaterExecutionError extends ProtocolError {
  constructor(code, details = []) {
    super(`Updater 执行中断：${code}`, details)
    this.code = code
    this.kind = 'infrastructure'
    this.retryable = true
  }
}

// Driver 负责结束自身进程或容器；看门狗不修改原生 Agent 或其模型输出。
export async function superviseUpdater({ execute, sample, idleTimeoutMs = 600_000, pollMs = 1000 }) {
  if (![idleTimeoutMs, pollMs].every((value) => Number.isFinite(value) && value > 0)) {
    throw new ProtocolError('Updater 看门狗时间必须为正数')
  }
  const controller = new AbortController()
  const streamWatch = new StreamWatch()
  let stopped = false
  let failure = null
  let sampleFailures = 0
  const monitor = (async () => {
    while (!stopped) {
      try {
        const status = sample ? await sample() : streamWatch.snapshot()
        if (stopped) return
        if (!Number.isFinite(status?.lastProgressAt)) throw new Error('invalid progress')
        sampleFailures = 0
        const code = status.failureCode ?? (Date.now() - status.lastProgressAt >= idleTimeoutMs
          ? 'updater-idle-timeout' : null)
        if (code) {
          failure = new UpdaterExecutionError(code)
          controller.abort()
          return
        }
      } catch {
        if (++sampleFailures >= 3) {
          failure = new UpdaterExecutionError('updater-monitor-unavailable')
          controller.abort()
          return
        }
      }
      await delay(pollMs, undefined, { signal: controller.signal }).catch(() => {})
    }
  })()
  try {
    const result = await execute({ signal: controller.signal, streamWatch })
    stopped = true
    controller.abort()
    await monitor
    if (failure) throw failure
    let finalStatus
    try { finalStatus = sample ? await sample() : streamWatch.snapshot() }
    catch { throw new UpdaterExecutionError('updater-monitor-unavailable') }
    if (finalStatus.failureCode) throw new UpdaterExecutionError(finalStatus.failureCode)
    return result
  } catch (error) {
    throw failure ?? error
  } finally {
    stopped = true
    controller.abort()
    await monitor
  }
}
