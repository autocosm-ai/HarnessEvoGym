import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Evolution 运行时监控与统计
 *
 * 职责：
 * - 实时记录 Evolution 进度
 * - 统计时间消耗
 * - 统计 Token 使用
 * - 统计失败类型分布
 * - 生成监控报告
 */
export class EvolutionMonitor {
  constructor() {
    this.startTime = Date.now()
    this.events = []
    this.generationStats = new Map()
    this.tokenUsage = {
      solver: { prompt: 0, completion: 0, total: 0 },
      updater: { prompt: 0, completion: 0, total: 0 },
      total: { prompt: 0, completion: 0, total: 0 },
    }
    this.phaseTimings = new Map()
    this.currentPhase = null
    this.currentPhaseStart = null
  }

  /**
   * 记录事件
   */
  recordEvent({ stage, generation = null, message, ...extra }) {
    const event = {
      timestamp: new Date().toISOString(),
      elapsed: Date.now() - this.startTime,
      stage,
      generation,
      message,
      ...extra,
    }
    this.events.push(event)
  }

  /**
   * 开始一个阶段
   */
  startPhase(phase) {
    if (this.currentPhase) {
      this.endPhase()
    }
    this.currentPhase = phase
    this.currentPhaseStart = Date.now()
  }

  /**
   * 结束当前阶段
   */
  endPhase() {
    if (this.currentPhase && this.currentPhaseStart) {
      const duration = Date.now() - this.currentPhaseStart
      if (!this.phaseTimings.has(this.currentPhase)) {
        this.phaseTimings.set(this.currentPhase, [])
      }
      this.phaseTimings.get(this.currentPhase).push(duration)
      this.currentPhase = null
      this.currentPhaseStart = null
    }
  }

  /**
   * 记录代数统计
   */
  recordGeneration({ generation, candidateId, status, decision }) {
    if (!this.generationStats.has(generation)) {
      this.generationStats.set(generation, {
        generation,
        candidates: [],
        promoted: 0,
        rejected: 0,
        invalid: 0,
        startTime: Date.now(),
        endTime: null,
      })
    }
    const stats = this.generationStats.get(generation)
    stats.candidates.push({ candidateId, status, decision })
    if (status === 'promoted') stats.promoted += 1
    else if (status === 'rejected') stats.rejected += 1
    else if (status === 'invalid-proposal') stats.invalid += 1
    stats.endTime = Date.now()
  }

  /**
   * 记录 Token 使用
   */
  recordTokenUsage({ role, promptTokens = 0, completionTokens = 0 }) {
    if (role !== 'solver' && role !== 'updater') return
    if (![promptTokens, completionTokens].every((value) => Number.isFinite(value) && value >= 0)) {
      throw new TypeError('Token 数必须为非负有限数字')
    }

    this.tokenUsage[role].prompt += promptTokens
    this.tokenUsage[role].completion += completionTokens
    this.tokenUsage[role].total += promptTokens + completionTokens

    this.tokenUsage.total.prompt += promptTokens
    this.tokenUsage.total.completion += completionTokens
    this.tokenUsage.total.total += promptTokens + completionTokens
  }

  /**
   * 生成统计摘要
   */
  generateSummary() {
    const totalDuration = Date.now() - this.startTime
    const generations = Array.from(this.generationStats.values())

    // 阶段耗时统计
    const phaseTimingSummary = {}
    for (const [phase, durations] of this.phaseTimings.entries()) {
      const total = durations.reduce((sum, d) => sum + d, 0)
      const avg = total / durations.length
      const min = Math.min(...durations)
      const max = Math.max(...durations)
      phaseTimingSummary[phase] = {
        count: durations.length,
        total: Math.round(total),
        average: Math.round(avg),
        min: Math.round(min),
        max: Math.round(max),
      }
    }

    // Generation 统计
    const generationSummary = generations.map((gen) => ({
      generation: gen.generation,
      candidates: gen.candidates.length,
      promoted: gen.promoted,
      rejected: gen.rejected,
      invalid: gen.invalid,
      duration: gen.endTime ? gen.endTime - gen.startTime : null,
    }))

    return {
      totalDuration,
      totalGenerations: generations.length,
      totalCandidates: generations.reduce((sum, g) => sum + g.candidates.length, 0),
      totalPromoted: generations.reduce((sum, g) => sum + g.promoted, 0),
      totalRejected: generations.reduce((sum, g) => sum + g.rejected, 0),
      totalInvalid: generations.reduce((sum, g) => sum + g.invalid, 0),
      tokenUsage: this.tokenUsage,
      phaseTimings: phaseTimingSummary,
      generationSummary,
      events: this.events.length,
    }
  }

  /**
   * 生成人类可读报告
   */
  generateReport() {
    const summary = this.generateSummary()
    const lines = []

    lines.push('📊 Evolution 运行监控报告')
    lines.push('')
    lines.push(`总运行时间：${formatDuration(summary.totalDuration)}`)
    lines.push(`总代数：${summary.totalGenerations}`)
    lines.push(`总 Candidate 数：${summary.totalCandidates}`)
    lines.push(`  - 晋升：${summary.totalPromoted}`)
    lines.push(`  - 拒绝：${summary.totalRejected}`)
    lines.push(`  - 无效：${summary.totalInvalid}`)
    lines.push('')

    // Token 使用统计
    lines.push('Token 使用统计：')
    lines.push(`  Solver:`)
    lines.push(`    - Prompt: ${summary.tokenUsage.solver.prompt.toLocaleString()}`)
    lines.push(`    - Completion: ${summary.tokenUsage.solver.completion.toLocaleString()}`)
    lines.push(`    - Total: ${summary.tokenUsage.solver.total.toLocaleString()}`)
    lines.push(`  Updater:`)
    lines.push(`    - Prompt: ${summary.tokenUsage.updater.prompt.toLocaleString()}`)
    lines.push(`    - Completion: ${summary.tokenUsage.updater.completion.toLocaleString()}`)
    lines.push(`    - Total: ${summary.tokenUsage.updater.total.toLocaleString()}`)
    lines.push(`  总计: ${summary.tokenUsage.total.total.toLocaleString()} tokens`)
    lines.push('')

    // 阶段耗时统计
    if (Object.keys(summary.phaseTimings).length > 0) {
      lines.push('阶段耗时统计：')
      for (const [phase, stats] of Object.entries(summary.phaseTimings)) {
        lines.push(`  ${phase}:`)
        lines.push(`    - 执行次数: ${stats.count}`)
        lines.push(`    - 总耗时: ${formatDuration(stats.total)}`)
        lines.push(`    - 平均: ${formatDuration(stats.average)}`)
        lines.push(`    - 最快: ${formatDuration(stats.min)}`)
        lines.push(`    - 最慢: ${formatDuration(stats.max)}`)
      }
      lines.push('')
    }

    // Generation 详情
    if (summary.generationSummary.length > 0) {
      lines.push('代数详情：')
      for (const gen of summary.generationSummary) {
        lines.push(`  Generation ${gen.generation}:`)
        lines.push(`    - Candidates: ${gen.candidates}`)
        lines.push(`    - 晋升: ${gen.promoted} / 拒绝: ${gen.rejected} / 无效: ${gen.invalid}`)
        if (gen.duration) {
          lines.push(`    - 耗时: ${formatDuration(gen.duration)}`)
        }
      }
      lines.push('')
    }

    lines.push(`事件总数：${summary.events}`)

    return lines.join('\n')
  }

  /**
   * 获取实时进度
   */
  getProgress() {
    const summary = this.generateSummary()
    return {
      elapsed: summary.totalDuration,
      generations: summary.totalGenerations,
      candidates: summary.totalCandidates,
      promoted: summary.totalPromoted,
      rejected: summary.totalRejected,
      invalid: summary.totalInvalid,
      tokenUsage: summary.tokenUsage.total.total,
      currentPhase: this.currentPhase,
    }
  }

  /**
   * 导出为 JSON
   */
  toJSON() {
    return {
      summary: this.generateSummary(),
      events: this.events,
    }
  }

  // 恢复累计统计，不把上次进程退出后的等待时间算作某个阶段的执行时间。
  snapshot() {
    return structuredClone({
      startTime: this.startTime, events: this.events,
      generationStats: [...this.generationStats], tokenUsage: this.tokenUsage,
      phaseTimings: [...this.phaseTimings],
    })
  }

  restore(snapshot) {
    if (!snapshot) return
    const copy = structuredClone(snapshot)
    this.startTime = copy.startTime
    this.events = copy.events
    this.generationStats = new Map(copy.generationStats)
    this.tokenUsage = copy.tokenUsage
    this.phaseTimings = new Map(copy.phaseTimings)
  }

  /**
   * 保存监控数据
   */
  async save(filepath) {
    await writeFile(filepath, JSON.stringify(this.toJSON(), null, 2), 'utf8')
  }

  /**
   * 保存人类可读报告
   */
  async saveReport(filepath) {
    await writeFile(filepath, this.generateReport(), 'utf8')
  }
}

/**
 * 格式化时长
 */
function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`
  return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`
}

/**
 * 创建 Evolution Monitor
 */
export function createEvolutionMonitor() {
  return new EvolutionMonitor()
}
