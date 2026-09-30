/**
 * 题目失败追踪与报告
 *
 * 职责：
 * - 追踪所有 Candidate 在题目级别的失败
 * - 统计失败次数最多的题目
 * - 统计每个 Candidate 失败的题目数量
 * - 跨代对比，识别"始终失败"和"新增失败"题目
 * - 生成失败摘要报告
 */
export function createTaskFailureTracker() {
  const failures = []
  const taskFailureMap = new Map() // instanceId -> { instanceId, failureCount, generations, partitions, failureKinds, reasonCodes }
  const candidateFailureMap = new Map() // candidateId -> { candidateId, failureCount, failedTaskIds }
  const generationTasks = new Map() // generation -> Set<instanceId>
  const observedTasks = new Map() // generation -> Set<instanceId>，未执行不能算改善
  let hasExplicitObservations = false

  function recordObservedTask({ generation, instanceId }) {
    if (!observedTasks.has(generation)) observedTasks.set(generation, new Set())
    observedTasks.get(generation).add(instanceId)
  }

  function recordTaskObservation({ generation, instanceId }) {
    hasExplicitObservations = true
    recordObservedTask({ generation, instanceId })
  }

  /**
   * 记录一次题目失败
   */
  function recordTaskFailure({
    generation,
    candidateId,
    partition,
    instanceId,
    reward,
    status,
    failureKind = null,
    reasonCode = null,
  }) {
    // 失败本身也是一次观测，但不要把旧版只调用 recordTaskFailure() 的
    // 使用者误判成“新 API 已经提供了完整成功观测”。
    recordObservedTask({ generation, instanceId })
    const failure = {
      timestamp: new Date().toISOString(),
      generation,
      candidateId,
      partition,
      instanceId,
      reward,
      status,
      failureKind,
      reasonCode,
    }

    failures.push(failure)

    // 更新题目失败统计
    if (!taskFailureMap.has(instanceId)) {
      taskFailureMap.set(instanceId, {
        instanceId,
        failureCount: 0,
        generations: new Set(),
        partitions: new Set(),
        failureKinds: new Set(),
        reasonCodes: new Set(),
      })
    }
    const taskStats = taskFailureMap.get(instanceId)
    taskStats.failureCount += 1
    taskStats.generations.add(generation)
    taskStats.partitions.add(partition)
    if (failureKind) taskStats.failureKinds.add(failureKind)
    if (reasonCode) taskStats.reasonCodes.add(reasonCode)

    // 更新 Candidate 失败统计
    if (!candidateFailureMap.has(candidateId)) {
      candidateFailureMap.set(candidateId, {
        candidateId,
        failureCount: 0,
        failedTaskIds: new Set(),
      })
    }
    const candidateStats = candidateFailureMap.get(candidateId)
    candidateStats.failureCount += 1
    candidateStats.failedTaskIds.add(instanceId)

    // 记录每代的失败题目
    if (!generationTasks.has(generation)) {
      generationTasks.set(generation, new Set())
    }
    generationTasks.get(generation).add(instanceId)
  }

  /**
   * 跨代分析：识别始终失败和新增失败的题目
   */
  function analyzeCrossGenerationFailures() {
    if (generationTasks.size === 0) {
      return {
        alwaysFailingTasks: [],
        newlyFailingTasks: [],
        improvedTasks: [],
      }
    }

    // 成功观测也属于一代；只遍历失败代会漏掉“最后一代全部恢复”的情况。
    const generations = Array.from(hasExplicitObservations ? observedTasks.keys() : generationTasks.keys())
      .sort((a, b) => a - b)
    const firstGen = generations[0]
    const lastGen = generations[generations.length - 1]

    const firstGenTasks = generationTasks.get(firstGen) || new Set()
    const lastGenTasks = generationTasks.get(lastGen) || new Set()

    // 始终失败：从第一代到最后一代都失败
    const alwaysFailingTasks = []
    for (const taskId of firstGenTasks) {
      const taskStats = taskFailureMap.get(taskId)
      // 检查是否在所有代都失败
      const failedInAllGenerations = generations.every((gen) =>
        generationTasks.get(gen)?.has(taskId)
      )
      if (failedInAllGenerations) {
        alwaysFailingTasks.push({
          instanceId: taskId,
          failureCount: taskStats.failureCount,
          generations: Array.from(taskStats.generations).sort((a, b) => a - b),
          failureKinds: Array.from(taskStats.failureKinds).sort(),
          reasonCodes: Array.from(taskStats.reasonCodes).sort(),
        })
      }
    }

    // 新增失败：最后一代失败，但第一代没失败
    const newlyFailingTasks = []
    for (const taskId of lastGenTasks) {
      if (!firstGenTasks.has(taskId)
          && (!hasExplicitObservations || observedTasks.get(firstGen)?.has(taskId))) {
        const taskStats = taskFailureMap.get(taskId)
        newlyFailingTasks.push({
          instanceId: taskId,
          failureCount: taskStats.failureCount,
          firstFailedGeneration: Math.min(...taskStats.generations),
          generations: Array.from(taskStats.generations).sort((a, b) => a - b),
          failureKinds: Array.from(taskStats.failureKinds).sort(),
          reasonCodes: Array.from(taskStats.reasonCodes).sort(),
        })
      }
    }

    // 改善的题目：第一代失败，最后一代成功
    const improvedTasks = []
    for (const taskId of firstGenTasks) {
      const explicitlyObservedAsCompleteRun = hasExplicitObservations
        && observedTasks.get(lastGen)?.has(taskId)
      if (!lastGenTasks.has(taskId)
          && (!hasExplicitObservations || explicitlyObservedAsCompleteRun)) {
        const taskStats = taskFailureMap.get(taskId)
        improvedTasks.push({
          instanceId: taskId,
          failureCount: taskStats.failureCount,
          lastFailedGeneration: Math.max(...taskStats.generations),
          generations: Array.from(taskStats.generations).sort((a, b) => a - b),
        })
      }
    }

    return {
      alwaysFailingTasks: alwaysFailingTasks.sort((a, b) => b.failureCount - a.failureCount),
      newlyFailingTasks: newlyFailingTasks.sort((a, b) => b.failureCount - a.failureCount),
      improvedTasks: improvedTasks.sort((a, b) => b.failureCount - a.failureCount),
    }
  }

  /**
   * 生成失败摘要
   */
  function generateReport() {
    if (failures.length === 0) {
      return {
        summary: {
          totalFailures: 0,
          failedTasks: 0,
          byPartition: {},
          byFailureKind: {},
          byReasonCode: {},
        },
        taskFailures: [],
        candidateFailures: [],
        crossGenerationAnalysis: {
          alwaysFailingTasks: [],
          newlyFailingTasks: [],
          improvedTasks: [],
        },
      }
    }

    const byPartition = {}
    const byFailureKind = {}
    const byReasonCode = {}

    for (const failure of failures) {
      byPartition[failure.partition] = (byPartition[failure.partition] || 0) + 1
      if (failure.failureKind) {
        byFailureKind[failure.failureKind] = (byFailureKind[failure.failureKind] || 0) + 1
      }
      if (failure.reasonCode) {
        byReasonCode[failure.reasonCode] = (byReasonCode[failure.reasonCode] || 0) + 1
      }
    }

    // 题目失败统计，按失败次数降序
    const taskFailures = Array.from(taskFailureMap.values())
      .map((task) => ({
        instanceId: task.instanceId,
        failureCount: task.failureCount,
        generations: Array.from(task.generations).sort((a, b) => a - b),
        partitions: Array.from(task.partitions).sort(),
        failureKinds: Array.from(task.failureKinds).sort(),
        reasonCodes: Array.from(task.reasonCodes).sort(),
      }))
      .sort((a, b) => b.failureCount - a.failureCount)

    // Candidate 失败统计，按失败次数降序
    const candidateFailures = Array.from(candidateFailureMap.values())
      .map((candidate) => ({
        candidateId: candidate.candidateId,
        failureCount: candidate.failureCount,
        failedTasks: candidate.failedTaskIds.size,
        failedTaskIds: Array.from(candidate.failedTaskIds).sort(),
      }))
      .sort((a, b) => b.failureCount - a.failureCount)

    // 跨代分析
    const crossGenerationAnalysis = analyzeCrossGenerationFailures()

    return {
      summary: {
        totalFailures: failures.length,
        failedTasks: taskFailureMap.size,
        byPartition,
        byFailureKind,
        byReasonCode,
        alwaysFailingCount: crossGenerationAnalysis.alwaysFailingTasks.length,
        newlyFailingCount: crossGenerationAnalysis.newlyFailingTasks.length,
        improvedCount: crossGenerationAnalysis.improvedTasks.length,
      },
      taskFailures,
      candidateFailures,
      crossGenerationAnalysis,
    }
  }

  /**
   * 生成人类可读的失败报告文本
   */
  function generateReportText() {
    const report = generateReport()

    if (report.summary.totalFailures === 0) {
      return '所有题目执行正常，无失败记录。'
    }

    const lines = []
    lines.push(`📊 题目失败统计报告`)
    lines.push('')
    lines.push(`总失败次数：${report.summary.totalFailures}`)
    lines.push(`失败题目数：${report.summary.failedTasks}`)
    lines.push('')

    // 跨代分析摘要
    const { alwaysFailingCount, newlyFailingCount, improvedCount } = report.summary
    if (alwaysFailingCount > 0 || newlyFailingCount > 0 || improvedCount > 0) {
      lines.push('跨代趋势分析：')
      if (alwaysFailingCount > 0) {
        lines.push(`  🔴 始终失败：${alwaysFailingCount} 道题（从第一代到最后一代持续失败）`)
      }
      if (newlyFailingCount > 0) {
        lines.push(`  🟡 新增失败：${newlyFailingCount} 道题（最近几代才开始失败）`)
      }
      if (improvedCount > 0) {
        lines.push(`  🟢 已改善：${improvedCount} 道题（早期失败，后期成功）`)
      }
      lines.push('')
    }

    // 按 Partition 分类
    if (Object.keys(report.summary.byPartition).length > 0) {
      lines.push('按 Partition 分类：')
      for (const [partition, count] of Object.entries(report.summary.byPartition)) {
        lines.push(`  - ${partition}: ${count} 次`)
      }
      lines.push('')
    }

    // 按失败类型分类
    if (Object.keys(report.summary.byFailureKind).length > 0) {
      lines.push('按失败类型分类：')
      for (const [kind, count] of Object.entries(report.summary.byFailureKind)) {
        lines.push(`  - ${kind}: ${count} 次`)
      }
      lines.push('')
    }

    // Top 10 失败最多的题目
    if (report.taskFailures.length > 0) {
      lines.push(`失败次数最多的题目 (Top ${Math.min(10, report.taskFailures.length)})：`)
      for (const task of report.taskFailures.slice(0, 10)) {
        lines.push(`  ${task.instanceId}`)
        lines.push(`    失败次数：${task.failureCount}`)
        lines.push(`    失败代数：${task.generations.join(', ')}`)
        if (task.failureKinds.length > 0) {
          lines.push(`    失败类型：${task.failureKinds.join(', ')}`)
        }
        if (task.reasonCodes.length > 0) {
          lines.push(`    原因代码：${task.reasonCodes.join(', ')}`)
        }
      }
      lines.push('')
    }

    // 始终失败的题目（高优先级）
    if (report.crossGenerationAnalysis.alwaysFailingTasks.length > 0) {
      lines.push('🔴 始终失败的题目（需要优先处理）：')
      for (const task of report.crossGenerationAnalysis.alwaysFailingTasks.slice(0, 10)) {
        lines.push(`  ${task.instanceId}`)
        lines.push(`    失败次数：${task.failureCount}`)
        lines.push(`    涉及代数：${task.generations.join(', ')}`)
        if (task.failureKinds.length > 0) {
          lines.push(`    失败类型：${task.failureKinds.join(', ')}`)
        }
      }
      lines.push('')
    }

    // 新增失败的题目
    if (report.crossGenerationAnalysis.newlyFailingTasks.length > 0) {
      lines.push('🟡 新增失败的题目（可能是性能退化）：')
      for (const task of report.crossGenerationAnalysis.newlyFailingTasks.slice(0, 10)) {
        lines.push(`  ${task.instanceId}`)
        lines.push(`    首次失败：Generation ${task.firstFailedGeneration}`)
        lines.push(`    失败次数：${task.failureCount}`)
        if (task.failureKinds.length > 0) {
          lines.push(`    失败类型：${task.failureKinds.join(', ')}`)
        }
      }
      lines.push('')
    }

    return lines.join('\n')
  }

  /**
   * 获取高优先级失败题目列表（用于 Feedback Packet）
   */
  function getPriorityFailedTasks(limit = 20) {
    const report = generateReport()
    const { alwaysFailingTasks, newlyFailingTasks } = report.crossGenerationAnalysis

    // 优先级：始终失败 > 新增失败 > 其他高频失败
    const priorityTasks = [
      ...alwaysFailingTasks.map((task) => ({ ...task, priority: 'always-failing' })),
      ...newlyFailingTasks.map((task) => ({ ...task, priority: 'newly-failing' })),
    ]

    // 补充其他高频失败（排除已在上面的）
    const coveredIds = new Set(priorityTasks.map((t) => t.instanceId))
    const otherHighFrequency = report.taskFailures
      .filter((task) => !coveredIds.has(task.instanceId))
      .slice(0, limit)
      .map((task) => ({ ...task, priority: 'high-frequency' }))

    return [...priorityTasks, ...otherHighFrequency].slice(0, limit)
  }

  return {
    recordTaskObservation,
    recordTaskFailure,
    generateReport,
    generateReportText,
    getPriorityFailedTasks,
  }
}
