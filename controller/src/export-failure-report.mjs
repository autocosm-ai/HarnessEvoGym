import { join } from 'node:path'

/**
 * 导出 Updater 失败报告
 *
 * 在 Evolution 运行结束后，将失败统计导出为 JSON 和文本格式
 */
export async function exportUpdaterFailureReport({
  failureTracker,
  runRoot,
  runId,
}) {
  const report = failureTracker.generateReport()
  const reportText = failureTracker.generateReportText()

  // 导出 JSON 格式
  const jsonPath = join(runRoot, 'updater-failure-report.json')
  await failureTracker.saveToFile(jsonPath)

  // 导出人类可读文本
  const textPath = join(runRoot, 'updater-failure-report.txt')
  await failureTracker.saveReportToFile(textPath)

  return {
    summary: report.summary,
    jsonPath,
    textPath,
    hasFailures: report.summary.totalFailures > 0,
  }
}

/**
 * 从失败报告中识别需要关注的高频失败模式
 */
export function analyzeFailurePatterns(failureTracker) {
  const summary = failureTracker.getSummary()
  const patterns = []

  // 识别超时问题
  if (summary.timeouts > 0) {
    const timeoutRate = summary.timeouts / summary.totalFailures
    if (timeoutRate > 0.3) {
      patterns.push({
        type: 'high-timeout-rate',
        severity: 'high',
        message: `超时失败占比 ${(timeoutRate * 100).toFixed(1)}%，建议检查 Updater 超时配置或执行环境性能`,
        count: summary.timeouts,
      })
    }
  }

  // 识别特定阶段的集中失败
  for (const [stage, count] of Object.entries(summary.byStage)) {
    const stageRate = count / summary.totalFailures
    if (stageRate > 0.5) {
      patterns.push({
        type: 'stage-concentration',
        severity: 'medium',
        message: `${stage} 阶段失败占比 ${(stageRate * 100).toFixed(1)}%`,
        stage,
        count,
      })
    }
  }

  // 识别基础设施失败
  if (summary.byErrorType?.infrastructure) {
    const infraRate = summary.byErrorType.infrastructure / summary.totalFailures
    if (infraRate > 0.4) {
      patterns.push({
        type: 'infrastructure-issues',
        severity: 'high',
        message: `基础设施失败占比 ${(infraRate * 100).toFixed(1)}%，建议检查 Docker、网络、资源配置`,
        count: summary.byErrorType.infrastructure,
      })
    }
  }

  return patterns
}
