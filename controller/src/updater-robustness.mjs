import { ProtocolError } from './protocol.mjs'
import { normalizeRelativePath } from './path-policy.mjs'

/**
 * Updater 鲁棒性增强模块
 *
 * 职责：
 * - 超时策略配置与管理
 * - 输出格式验证增强
 * - Diff 安全检查
 * - 失败诊断与降级策略
 */

/**
 * Updater 超时配置策略
 *
 * 根据 mutation level 和历史执行时间动态调整超时时间
 */
export function calculateUpdaterTimeout({
  mutationLevel,
  baseTimeoutSeconds = 1800, // 30 分钟默认
  historicalDurations = [],
  safetyFactor = 1.5,
}) {
  if (!['l1', 'l2', 'l3'].includes(mutationLevel)) {
    throw new ProtocolError(`未知 Updater mutation level：${mutationLevel}`)
  }
  if (!Number.isFinite(baseTimeoutSeconds) || baseTimeoutSeconds <= 0) {
    throw new ProtocolError('Updater baseTimeoutSeconds 必须是正数')
  }
  if (!Array.isArray(historicalDurations)
      || historicalDurations.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new ProtocolError('Updater historicalDurations 必须是非负有限数字数组')
  }
  if (!Number.isFinite(safetyFactor) || safetyFactor < 1) {
    throw new ProtocolError('Updater safetyFactor 必须不小于 1')
  }
  // 基础超时按风险等级递增
  const levelMultipliers = {
    l1: 1.0,   // L1: Prompt 修改，最简单
    l2: 1.5,   // L2: 工具函数修改，中等复杂
    l3: 2.0,   // L3: 核心算法修改，最复杂
  }

  const multiplier = levelMultipliers[mutationLevel] ?? 1.0
  let timeoutSeconds = baseTimeoutSeconds * multiplier

  // 如果有历史数据，使用 P95 + safety factor
  if (historicalDurations.length > 0) {
    const sorted = [...historicalDurations].sort((a, b) => a - b)
    const p95Index = Math.ceil(sorted.length * 0.95) - 1
    const p95Duration = sorted[Math.max(0, p95Index)]
    const historicalTimeout = (p95Duration / 1000) * safetyFactor

    // 取历史数据和基础策略的较大值
    timeoutSeconds = Math.max(timeoutSeconds, historicalTimeout)
  }

  // 设置上下限
  const minTimeout = 300  // 5 分钟
  const maxTimeout = 3600 // 60 分钟

  return Math.max(minTimeout, Math.min(maxTimeout, timeoutSeconds))
}

/**
 * 增强的 Mutation Report 验证
 *
 * 在基础验证之上增加：
 * - 字段长度限制
 * - 内容质量检查
 * - 危险模式检测
 */
export function validateMutationReportEnhanced(report) {
  const warnings = []
  const errors = []

  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    return { valid: false, errors: ['Mutation Report 必须是 JSON 对象'], warnings }
  }

  // 字段长度限制
  const fieldLimits = {
    diagnosis: { min: 50, max: 2000, name: 'diagnosis（问题诊断）' },
    hypothesis: { min: 50, max: 1000, name: 'hypothesis（改进假设）' },
    expectedImpact: { min: 30, max: 1000, name: 'expectedImpact（预期影响）' },
    remainingRisks: { min: 20, max: 1000, name: 'remainingRisks（剩余风险）' },
  }

  for (const [field, limits] of Object.entries(fieldLimits)) {
    const value = report[field]
    if (!value || typeof value !== 'string') {
      errors.push(`${limits.name} 字段缺失或类型错误`)
      continue
    }
    const length = value.trim().length
    if (length < limits.min) {
      warnings.push(`${limits.name} 过短（${length} < ${limits.min}），可能缺少关键信息`)
    }
    if (length > limits.max) {
      errors.push(`${limits.name} 过长（${length} > ${limits.max}），超出限制`)
    }
  }

  // 内容质量检查：避免占位符和空洞内容
  const placeholderPatterns = [
    /TODO|FIXME|TBD|XXX|PLACEHOLDER/i,
    /待补充|待完善|暂无|未知/,
    /Lorem ipsum/i,
  ]

  for (const field of ['diagnosis', 'hypothesis', 'expectedImpact']) {
    const value = report[field] ?? ''
    for (const pattern of placeholderPatterns) {
      if (pattern.test(value)) {
        errors.push(`${field} 包含占位符内容：${pattern}`)
        break
      }
    }
  }

  // 检查 changedFiles 是否合理
  if (!Array.isArray(report.changedFiles)) {
    errors.push('changedFiles 必须是字符串数组')
  } else {
    if (report.changedFiles.length === 0) {
      errors.push('changedFiles 为空，Updater 未产生任何改动')
    }
    if (report.changedFiles.some((value) => typeof value !== 'string' || value.trim().length === 0)) {
      errors.push('changedFiles 只能包含非空字符串')
    }
    if (report.changedFiles.length > 100) {
      warnings.push(`changedFiles 数量过多（${report.changedFiles.length}），可能改动范围过大`)
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}

/**
 * Diff 安全检查增强
 *
 * 检测危险的文件操作模式：
 * - 删除关键文件
 * - 修改配置文件但未说明
 * - 大规模重命名
 * - 疑似格式化导致的噪音改动
 */
export function validateDiffSafety(changes, mutationReport) {
  const warnings = []
  const errors = []

  if (!Array.isArray(changes)) {
    return { safe: false, errors: ['Diff changes 必须是数组'], warnings }
  }
  if (!mutationReport || typeof mutationReport !== 'object' || Array.isArray(mutationReport)) {
    return { safe: false, errors: ['Mutation Report 必须是 JSON 对象'], warnings }
  }

  // Diff 来自可信 Snapshot，但仍要在这里做协议边界校验；否则一个缺少
  // path 的记录会在二进制扩展名检查等位置触发 TypeError，绕过正常的
  // CandidateMutationError 拒绝路径。
  const normalizedChanges = []
  for (const [index, change] of changes.entries()) {
    if (!change || typeof change !== 'object' || Array.isArray(change)) {
      errors.push(`changes[${index}] 必须是对象`)
      continue
    }
    let path
    try {
      path = normalizeRelativePath(change.path, `changes[${index}].path`)
    } catch (error) {
      errors.push(error.message)
      continue
    }
    if (!Object.prototype.hasOwnProperty.call(change, 'before')
        || !Object.prototype.hasOwnProperty.call(change, 'after')) {
      errors.push(`changes[${index}] 必须同时包含 before 和 after`)
      continue
    }
    const validSnapshot = (value) => value === null
      || (value && typeof value === 'object' && !Array.isArray(value))
    if (!validSnapshot(change.before) || !validSnapshot(change.after)) {
      errors.push(`changes[${index}] 的 before/after 必须是对象或 null`)
      continue
    }
    normalizedChanges.push({ ...change, path })
  }
  if (errors.length > 0) return { safe: false, errors, warnings }
  changes = normalizedChanges

  // 检测删除操作
  const deletions = changes.filter((change) => change.after === null)
  if (deletions.length > 0) {
    // 检查是否删除关键文件
    const criticalPatterns = [
      /package\.json$/,
      /tsconfig\.json$/,
      /\.gitignore$/,
      /README\.md$/i,
      /LICENSE$/i,
      /Dockerfile$/,
    ]

    for (const deletion of deletions) {
      for (const pattern of criticalPatterns) {
        if (pattern.test(deletion.path)) {
          warnings.push(`删除关键文件：${deletion.path}`)
        }
      }
    }

    // 检查 mutation report 是否说明删除原因
    const reportText = `${mutationReport.diagnosis} ${mutationReport.hypothesis}`.toLowerCase()
    const mentionsDelete = /删除|移除|delete|remove/i.test(reportText)
    if (deletions.length > 0 && !mentionsDelete) {
      warnings.push(`删除了 ${deletions.length} 个文件但 report 未说明原因`)
    }
  }

  // 检测大规模重命名（删除 + 新增同等数量文件）
  const additions = changes.filter((change) => change.before === null && change.after !== null)
  if (deletions.length > 5 && additions.length > 5 && Math.abs(deletions.length - additions.length) <= 2) {
    warnings.push(`疑似大规模重命名操作：删除 ${deletions.length} 个文件，新增 ${additions.length} 个文件`)
  }

  // 检测配置文件修改
  const configPatterns = [
    /\.ya?ml$/,
    /\.json$/,
    /\.toml$/,
    /\.ini$/,
    /\.env/,
    /config\./i,
  ]

  const configChanges = changes.filter((change) =>
    change.before && change.after && configPatterns.some((pattern) => pattern.test(change.path))
  )

  if (configChanges.length > 0) {
    const reportText = `${mutationReport.diagnosis} ${mutationReport.hypothesis}`.toLowerCase()
    const mentionsConfig = /配置|config|设置|参数/i.test(reportText)
    if (!mentionsConfig) {
      warnings.push(`修改了 ${configChanges.length} 个配置文件但 report 未提及`)
    }
  }

  // 检测疑似格式化噪音：修改大量文件但报告中未提及
  const modifications = changes.filter((change) => change.before && change.after)
  if (modifications.length > 10) {
    const reportedFiles = new Set(mutationReport.changedFiles ?? [])
    const unreportedCount = modifications.filter((change) => !reportedFiles.has(change.path)).length
    if (unreportedCount > modifications.length * 0.3) {
      warnings.push(`${unreportedCount} 个文件被修改但未在 changedFiles 中列出，可能存在格式化噪音`)
    }
  }

  // 检测二进制文件修改
  const binaryExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.pdf', '.zip', '.tar', '.gz', '.bin', '.exe', '.so', '.dylib', '.dll']
  const binaryChanges = changes.filter((change) =>
    binaryExtensions.some((ext) => change.path.toLowerCase().endsWith(ext))
  )
  if (binaryChanges.length > 0) {
    warnings.push(`修改了 ${binaryChanges.length} 个二进制文件：${binaryChanges.map((c) => c.path).join('、')}`)
  }

  return {
    safe: errors.length === 0,
    errors,
    warnings,
  }
}

/**
 * Updater 失败诊断与降级策略
 *
 * 根据失败模式提供诊断信息和建议
 */
export function diagnoseUpdaterFailure(error, context) {
  const diagnosis = {
    failureKind: 'unknown',
    message: error.message,
    possibleCauses: [],
    recommendations: [],
    shouldRetry: false,
    degradationStrategy: null,
  }

  // 超时失败
  if (error.name === 'UpdaterRunError'
      && (error.result?.timedOut === true || error.stage === 'updater-timeout')) {
    diagnosis.failureKind = 'timeout'
    // context 默认是 {}；缺失时不能把 undefined/1000 写成 NaN 落盘。
    const timeoutMs = Number.isFinite(error.context?.timeoutMs) ? error.context.timeoutMs : null
    diagnosis.possibleCauses.push(
      timeoutMs === null ? 'Updater 执行超过配置的超时上限' : `Updater 执行超过 ${timeoutMs / 1000}s 限制`,
      '任务复杂度超出预期',
      'API 响应缓慢',
    )
    diagnosis.recommendations.push(
      `考虑增加 ${context.mutationLevel} 的超时时间`,
      '检查是否可以简化 feedback 数据',
      '检查 API 响应时间是否异常',
    )
    diagnosis.shouldRetry = false
    diagnosis.degradationStrategy = 'skip-generation'
  }

  // 输出格式错误
  if (error.message?.includes('Mutation Report')) {
    diagnosis.failureKind = 'invalid-output-format'
    diagnosis.possibleCauses.push(
      'Updater 未按协议格式输出',
      'mutation-report.json 缺失或格式错误',
      'Updater prompt 未正确传达输出要求',
    )
    diagnosis.recommendations.push(
      '检查 Updater prompt 是否明确输出格式要求',
      '检查 Updater 日志中的错误信息',
      '验证 output directory 权限',
    )
    diagnosis.shouldRetry = false
    diagnosis.degradationStrategy = 'skip-generation'
  }

  // Diff 越界
  if (error.message?.includes('越界 Diff')) {
    diagnosis.failureKind = 'policy-violation'
    diagnosis.possibleCauses.push(
      'Updater 修改了禁止修改的文件',
      'Mutation Policy 配置过于严格',
      'Updater 理解 writable paths 有误',
    )
    diagnosis.recommendations.push(
      '检查 writable/readOnly 配置是否合理',
      '检查 Updater 是否正确理解 mutation regions',
      '考虑放宽部分路径限制',
    )
    diagnosis.shouldRetry = false
    diagnosis.degradationStrategy = 'skip-generation'
  }

  // 语义检查失败
  if (error.message?.includes('语义检查失败')) {
    diagnosis.failureKind = 'semantic-violation'
    diagnosis.possibleCauses.push(
      'Updater 破坏了 Preset 约束',
      'Skills catalog 结构不合法',
      'Updater 未理解 semantic constraints',
    )
    diagnosis.recommendations.push(
      '检查 semantic constraints 是否在 Updater prompt 中清晰传达',
      '检查 Updater 输出日志中的语义错误',
      '考虑简化 semantic constraints',
    )
    diagnosis.shouldRetry = false
    diagnosis.degradationStrategy = 'skip-generation'
  }

  // 基础设施错误（可能可重试）
  if (error.kind === 'infrastructure') {
    diagnosis.failureKind = 'infrastructure'
    diagnosis.possibleCauses.push(
      'Docker 容器启动失败',
      '网络连接问题',
      '磁盘空间不足',
      '临时系统故障',
    )
    diagnosis.recommendations.push(
      '检查 Docker 守护进程状态',
      '检查磁盘空间',
      '检查网络连接',
      '可以考虑重试',
    )
    diagnosis.shouldRetry = true
    diagnosis.degradationStrategy = 'retry-once'
  }

  return diagnosis
}

/**
 * 创建 Updater 执行历史追踪器
 *
 * 用于记录历史执行时间，支持动态超时调整
 */
export function createUpdaterHistoryTracker(snapshot = []) {
  const history = new Map()
  if (!Array.isArray(snapshot) || snapshot.length > 3) throw new ProtocolError('Updater 历史快照无效')
  for (const [level, entries] of snapshot) {
    if (!['l1', 'l2', 'l3'].includes(level) || !Array.isArray(entries) || entries.length > 50
        || entries.some((entry) => !Number.isFinite(entry.durationMs) || entry.durationMs < 0
          || typeof entry.success !== 'boolean' || !Number.isFinite(entry.timestamp))) {
      throw new ProtocolError('Updater 历史快照无效')
    }
    history.set(level, structuredClone(entries))
  }

  return {
    record({ mutationLevel, durationMs, success }) {
      if (!['l1', 'l2', 'l3'].includes(mutationLevel) || !Number.isFinite(durationMs)
          || durationMs < 0 || typeof success !== 'boolean') {
        throw new ProtocolError('Updater 历史记录无效')
      }
      if (!history.has(mutationLevel)) {
        history.set(mutationLevel, [])
      }
      const durations = history.get(mutationLevel)
      durations.push({ durationMs, success, timestamp: Date.now() })

      // 只保留最近 50 次记录
      if (durations.length > 50) {
        durations.shift()
      }
    },

    getSuccessfulDurations(mutationLevel) {
      const durations = history.get(mutationLevel) ?? []
      return durations
        .filter((entry) => entry.success)
        .map((entry) => entry.durationMs)
    },

    getStatistics(mutationLevel) {
      const durations = history.get(mutationLevel) ?? []
      if (durations.length === 0) {
        return { count: 0, successRate: 0, avgDuration: 0 }
      }

      const successful = durations.filter((entry) => entry.success)
      const successRate = successful.length / durations.length
      const avgDuration = successful.length > 0
        ? successful.reduce((sum, entry) => sum + entry.durationMs, 0) / successful.length
        : 0

      return {
        count: durations.length,
        successRate,
        avgDuration,
        p50: calculatePercentile(successful.map((e) => e.durationMs), 0.5),
        p95: calculatePercentile(successful.map((e) => e.durationMs), 0.95),
      }
    },

    clear() {
      history.clear()
    },

    snapshot() {
      return structuredClone([...history])
    },
  }
}

function calculatePercentile(values, percentile) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.ceil(sorted.length * percentile) - 1
  return sorted[Math.max(0, index)]
}
