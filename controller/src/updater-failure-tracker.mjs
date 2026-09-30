import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Updater 失败追踪与报告
 *
 * 职责：
 * - 记录所有 Updater 执行失败
 * - 分类失败原因（越界 Diff、语义检查失败、Mutation Report 无效）
 * - 生成失败摘要报告
 * - 提供失败率统计
 */
export class UpdaterFailureTracker {
  constructor() {
    this.failures = []
    this.failuresByGeneration = new Map()
  }

  /**
   * 记录一次 Updater 失败
   */
  recordFailure({
    generation,
    candidateId,
    parentId,
    mutationPlanId,
    regionIds,
    stage,
    message,
    details = [],
    candidateDigest = null,
    errorType = null,
    exitCode = null,
    timedOut = false,
  }) {
    const failure = {
      timestamp: new Date().toISOString(),
      generation,
      candidateId,
      parentId,
      mutationPlanId,
      regionIds,
      stage,
      message,
      details,
      candidateDigest,
      errorType,
      exitCode,
      timedOut,
    }

    this.failures.push(failure)

    if (!this.failuresByGeneration.has(generation)) {
      this.failuresByGeneration.set(generation, [])
    }
    this.failuresByGeneration.get(generation).push(failure)
  }

  /**
   * 获取指定代数的失败记录
   */
  getFailuresByGeneration(generation) {
    return this.failuresByGeneration.get(generation) || []
  }

  /**
   * 获取所有失败记录
   */
  getAllFailures() {
    return this.failures
  }

  /**
   * 生成失败摘要
   */
  getSummary() {
    if (this.failures.length === 0) {
      return {
        totalFailures: 0,
        byStage: {},
        byGeneration: {},
        byErrorType: {},
        timeouts: 0,
        recentFailures: [],
      }
    }

    const byStage = {}
    const byGeneration = {}
    const byErrorType = {}
    let timeouts = 0

    for (const failure of this.failures) {
      byStage[failure.stage] = (byStage[failure.stage] || 0) + 1
      byGeneration[failure.generation] = (byGeneration[failure.generation] || 0) + 1
      if (failure.errorType) {
        byErrorType[failure.errorType] = (byErrorType[failure.errorType] || 0) + 1
      }
      if (failure.timedOut) {
        timeouts += 1
      }
    }

    return {
      totalFailures: this.failures.length,
      byStage,
      byGeneration,
      byErrorType,
      timeouts,
      recentFailures: this.failures.slice(-10),
    }
  }

  /**
   * 生成失败报告对象
   */
  generateReport() {
    return {
      summary: this.getSummary(),
      failures: this.failures,
    }
  }

  /**
   * 生成人类可读的报告文本
   */
  generateReportText() {
    const summary = this.getSummary()

    if (summary.totalFailures === 0) {
      return 'Updater 执行正常，无失败记录。'
    }

    const lines = []
    lines.push(`⚠️  Updater 失败统计 (共 ${summary.totalFailures} 次)`)
    lines.push('')

    lines.push('按失败阶段分类：')
    for (const [stage, count] of Object.entries(summary.byStage)) {
      lines.push(`  - ${stage}: ${count} 次`)
    }
    lines.push('')

    if (Object.keys(summary.byErrorType).length > 0) {
      lines.push('按错误类型分类：')
      for (const [errorType, count] of Object.entries(summary.byErrorType)) {
        lines.push(`  - ${errorType}: ${count} 次`)
      }
      lines.push('')
    }

    if (summary.timeouts > 0) {
      lines.push(`超时失败：${summary.timeouts} 次`)
      lines.push('')
    }

    lines.push('按代数分类：')
    for (const [generation, count] of Object.entries(summary.byGeneration)) {
      lines.push(`  - Generation ${generation}: ${count} 次`)
    }
    lines.push('')

    if (summary.recentFailures.length > 0) {
      lines.push('最近失败记录：')
      for (const failure of summary.recentFailures) {
        lines.push(`  [Gen ${failure.generation}] ${failure.candidateId}`)
        lines.push(`    Stage: ${failure.stage}`)
        if (failure.errorType) {
          lines.push(`    Type: ${failure.errorType}`)
        }
        if (failure.exitCode !== null) {
          lines.push(`    Exit Code: ${failure.exitCode}`)
        }
        if (failure.timedOut) {
          lines.push(`    ⏱️  Timeout`)
        }
        lines.push(`    Message: ${failure.message}`)
        if (failure.details.length > 0) {
          lines.push(`    Details: ${failure.details.slice(0, 3).join('; ')}`)
        }
        lines.push('')
      }
    }

    return lines.join('\n')
  }

  /**
   * 导出为 JSON
   */
  toJSON() {
    return {
      failures: this.failures,
      summary: this.getSummary(),
    }
  }

  /**
   * 保存到文件
   */
  async saveToFile(filepath) {
    await writeFile(filepath, JSON.stringify(this.toJSON(), null, 2), 'utf8')
  }

  /**
   * 保存报告到文件
   */
  async saveReportToFile(filepath) {
    await writeFile(filepath, this.generateReportText(), 'utf8')
  }
}

/**
 * 为 Branch 创建 Updater 失败追踪器实例
 */
export function createUpdaterFailureTracker() {
  return new UpdaterFailureTracker()
}
