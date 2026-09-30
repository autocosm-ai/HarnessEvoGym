import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { createEvolutionMonitor } from './evolution-monitor.mjs'
import { createTaskFailureTracker } from './task-failure-tracker.mjs'
import { createUpdaterFailureTracker } from './updater-failure-tracker.mjs'
import { createUpdaterHistoryTracker, diagnoseUpdaterFailure } from './updater-robustness.mjs'
import { writeJsonFile } from './protocol.mjs'

const MAXIMUM_OBSERVATIONS = 100_000
const MAXIMUM_UPDATER_FAILURES = 10_000

// 诊断随可信 Run State 一起保存。可读报告是投影，绝不参与评分或晋升。
export function createRunDiagnostics({ snapshot, secrets = [] } = {}) {
  const monitor = createEvolutionMonitor()
  monitor.restore(snapshot?.monitor)
  const updaterHistory = createUpdaterHistoryTracker(snapshot?.updaterHistory)
  const observations = new Map(snapshot?.observations ?? [])
  const updaterFailures = snapshot?.updaterFailures ?? []
  let previousUsage = { solver: {}, updater: {} }
  const usageOffset = structuredClone(monitor.tokenUsage)

  function redact(value) {
    const text = JSON.stringify(value, (_key, item) => typeof item === 'string'
      ? secrets.filter(Boolean).reduce((s, secret) => s.replaceAll(secret, '[REDACTED]'), item)
      : item)
    return JSON.parse(text)
  }

  return {
    monitor,
    updaterHistory,
    observeRecords({ generation, candidateId, partition, records }) {
      for (const [instanceId, record] of records) {
        const failure = record.solverFailures?.[0]
        // 合法的 0 分是能力不足，不冒充网络故障；负分同样保留原始分值。
        // 0 分可能只是合法的错误答案，不是基础设施失败；只有协议错误或
        // SolverFailure 才进入“失败”统计，原始 reward 仍保留在 observation。
        const badCase = record.status === 'error' || Boolean(failure)
        const observation = { generation, candidateId, partition, instanceId, reward: record.reward,
          status: record.status, badCase,
          failureKind: failure?.category ?? failure?.failureKind ?? failure?.kind ?? record.failureKind ?? null,
          reasonCode: failure?.code ?? failure?.reasonCode ?? record.reasonCode ?? null }
        const key = JSON.stringify([generation, candidateId, partition, instanceId])
        if (!observations.has(key) && observations.size >= MAXIMUM_OBSERVATIONS) {
          throw new Error(`Run 诊断观测超过 ${MAXIMUM_OBSERVATIONS} 条上限`)
        }
        observations.set(key, observation)
      }
    },
    updaterFailure({ error, ...context }) {
      const result = error.processResult ?? error.result ?? error.context?.result ?? {}
      const failure = redact({ ...context, timestamp: new Date().toISOString(),
        stage: error.stage ?? 'update-and-diff', message: error.message, details: error.details ?? [],
        errorType: error.name, exitCode: result.exitCode ?? null, timedOut: result.timedOut === true,
        diagnosis: diagnoseUpdaterFailure(error, context) })
      if (updaterFailures.length >= MAXIMUM_UPDATER_FAILURES) {
        throw new Error(`Updater 诊断失败记录超过 ${MAXIMUM_UPDATER_FAILURES} 条上限`)
      }
      updaterFailures.push(failure)
      monitor.recordEvent({ ...failure, stage: 'updater-failure' })
      return failure
    },
    async persist({ state, runRoot, solverUsage, updaterUsage }) {
      // Driver.usage 是本进程累计值。按快照偏移叠加，避免每次保存重复计数。
      previousUsage = { solver: solverUsage ?? previousUsage.solver, updater: updaterUsage ?? previousUsage.updater }
      for (const role of ['solver', 'updater']) {
        const usage = previousUsage[role]
        // usage 不完整时记录已观测 Token，未知部分仍通过 complete 标记保留。
        const prompt = usage.inputTokens ?? usage.observedInputTokens ?? usage.promptTokens ?? 0
        const completion = usage.outputTokens ?? usage.observedOutputTokens ?? usage.completionTokens ?? 0
        if (![prompt, completion].every((value) => Number.isFinite(value) && value >= 0)) {
          throw new Error(`${role} Token 使用量必须是非负有限数字`)
        }
        monitor.tokenUsage[role] = {
          prompt: usageOffset[role].prompt + prompt,
          completion: usageOffset[role].completion + completion,
          total: usageOffset[role].total + prompt + completion,
          complete: usageOffset[role].complete !== false && usage.complete !== false,
        }
      }
      for (const field of ['prompt', 'completion', 'total']) {
        monitor.tokenUsage.total[field] = monitor.tokenUsage.solver[field] + monitor.tokenUsage.updater[field]
      }
      monitor.tokenUsage.total.complete = monitor.tokenUsage.solver.complete && monitor.tokenUsage.updater.complete
      for (const entry of state.spec.searchHistory ?? []) {
        if (!monitor.generationStats.has(entry.generation)) monitor.recordGeneration({
          generation: entry.generation, candidateId: entry.proposalId,
          status: entry.status, decision: entry.selection ?? entry.rejection,
        })
      }
      const tasks = createTaskFailureTracker()
      for (const item of observations.values()) {
        tasks.recordTaskObservation(item)
        if (item.badCase) tasks.recordTaskFailure(item)
      }
      const updater = createUpdaterFailureTracker()
      for (const item of updaterFailures) updater.recordFailure(item)
      state.spec.diagnostics = { monitor: monitor.snapshot(), observations: [...observations], updaterFailures,
        updaterHistory: updaterHistory.snapshot() }
      await writeJsonFile(join(runRoot, 'state.json'), state)
      await Promise.all([
        writeJsonFile(join(runRoot, 'evolution-monitor.json'), monitor.toJSON()),
        writeFile(join(runRoot, 'evolution-monitor.txt'), `${monitor.generateReport()}\n`, { encoding: 'utf8', mode: 0o600 }),
        writeJsonFile(join(runRoot, 'task-failures.json'), tasks.generateReport()),
        writeFile(join(runRoot, 'task-failures.txt'), `${tasks.generateReportText()}\n`, { encoding: 'utf8', mode: 0o600 }),
        writeJsonFile(join(runRoot, 'updater-failures.json'), { ...updater.generateReport(), failures: updaterFailures }),
        writeFile(join(runRoot, 'updater-failures.txt'), `${updater.generateReportText()}\n`, { encoding: 'utf8', mode: 0o600 }),
      ])
    },
  }
}
