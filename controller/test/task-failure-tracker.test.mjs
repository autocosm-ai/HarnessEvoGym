import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createTaskFailureTracker } from '../src/task-failure-tracker.mjs'

describe('Task Failure Tracker', () => {
  it('初始状态无失败记录', () => {
    const tracker = createTaskFailureTracker()
    const report = tracker.generateReport()
    assert.equal(report.summary.totalFailures, 0)
    assert.equal(report.summary.failedTasks, 0)
    assert.equal(report.taskFailures.length, 0)
    assert.equal(report.candidateFailures.length, 0)
    assert.equal(report.crossGenerationAnalysis.alwaysFailingTasks.length, 0)
  })

  it('记录单个题目失败', () => {
    const tracker = createTaskFailureTracker()
    tracker.recordTaskFailure({
      generation: 1,
      candidateId: 'g001-L1',
      partition: 'feedback',
      instanceId: 'task-001',
      reward: 0,
      status: 'error',
      failureKind: 'candidate',
      reasonCode: 'timeout',
    })

    const report = tracker.generateReport()
    assert.equal(report.summary.totalFailures, 1)
    assert.equal(report.summary.failedTasks, 1)
    assert.equal(report.summary.byPartition.feedback, 1)
    assert.equal(report.summary.byFailureKind.candidate, 1)
    assert.equal(report.taskFailures.length, 1)
    assert.equal(report.taskFailures[0].instanceId, 'task-001')
    assert.equal(report.taskFailures[0].failureCount, 1)
  })

  it('追踪同一题目的多次失败', () => {
    const tracker = createTaskFailureTracker()
    tracker.recordTaskFailure({
      generation: 1,
      candidateId: 'g001-L1',
      partition: 'feedback',
      instanceId: 'task-001',
      reward: 0,
      status: 'error',
      failureKind: 'candidate',
      reasonCode: 'timeout',
    })
    tracker.recordTaskFailure({
      generation: 2,
      candidateId: 'g002-L1',
      partition: 'feedback',
      instanceId: 'task-001',
      reward: 0,
      status: 'error',
      failureKind: 'infrastructure',
      reasonCode: 'model_provider_failure',
    })
    tracker.recordTaskFailure({
      generation: 3,
      candidateId: 'g003-L1',
      partition: 'selection',
      instanceId: 'task-001',
      reward: 0,
      status: 'error',
      failureKind: 'candidate',
      reasonCode: 'invalid_output',
    })

    const report = tracker.generateReport()
    assert.equal(report.summary.totalFailures, 3)
    assert.equal(report.summary.failedTasks, 1)
    assert.equal(report.taskFailures[0].instanceId, 'task-001')
    assert.equal(report.taskFailures[0].failureCount, 3)
    assert.deepEqual(report.taskFailures[0].partitions, ['feedback', 'selection'])
    assert.deepEqual(
      new Set(report.taskFailures[0].failureKinds),
      new Set(['candidate', 'infrastructure']),
    )
  })

  it('统计不同题目的失败次数并排序', () => {
    const tracker = createTaskFailureTracker()

    // task-001 失败 3 次
    for (let i = 1; i <= 3; i++) {
      tracker.recordTaskFailure({
        generation: i,
        candidateId: `g00${i}-L1`,
        partition: 'feedback',
        instanceId: 'task-001',
        reward: 0,
        status: 'error',
        failureKind: 'candidate',
      })
    }

    // task-002 失败 5 次
    for (let i = 1; i <= 5; i++) {
      tracker.recordTaskFailure({
        generation: i,
        candidateId: `g00${i}-L1`,
        partition: 'feedback',
        instanceId: 'task-002',
        reward: 0,
        status: 'error',
        failureKind: 'candidate',
      })
    }

    // task-003 失败 1 次
    tracker.recordTaskFailure({
      generation: 1,
      candidateId: 'g001-L1',
      partition: 'feedback',
      instanceId: 'task-003',
      reward: 0,
      status: 'error',
      failureKind: 'candidate',
    })

    const report = tracker.generateReport()
    assert.equal(report.summary.totalFailures, 9)
    assert.equal(report.summary.failedTasks, 3)

    // 按失败次数降序排列
    assert.equal(report.taskFailures[0].instanceId, 'task-002')
    assert.equal(report.taskFailures[0].failureCount, 5)
    assert.equal(report.taskFailures[1].instanceId, 'task-001')
    assert.equal(report.taskFailures[1].failureCount, 3)
    assert.equal(report.taskFailures[2].instanceId, 'task-003')
    assert.equal(report.taskFailures[2].failureCount, 1)
  })

  it('按 Candidate 统计失败题目数量', () => {
    const tracker = createTaskFailureTracker()

    // g001-L1 在 3 道题上失败
    tracker.recordTaskFailure({
      generation: 1,
      candidateId: 'g001-L1',
      partition: 'feedback',
      instanceId: 'task-001',
      reward: 0,
      status: 'error',
      failureKind: 'candidate',
    })
    tracker.recordTaskFailure({
      generation: 1,
      candidateId: 'g001-L1',
      partition: 'feedback',
      instanceId: 'task-002',
      reward: 0,
      status: 'error',
      failureKind: 'candidate',
    })
    tracker.recordTaskFailure({
      generation: 1,
      candidateId: 'g001-L1',
      partition: 'feedback',
      instanceId: 'task-003',
      reward: 0,
      status: 'error',
      failureKind: 'candidate',
    })

    // g002-L1 在 1 道题上失败
    tracker.recordTaskFailure({
      generation: 2,
      candidateId: 'g002-L1',
      partition: 'feedback',
      instanceId: 'task-001',
      reward: 0,
      status: 'error',
      failureKind: 'candidate',
    })

    const report = tracker.generateReport()
    assert.equal(report.candidateFailures.length, 2)
    assert.equal(report.candidateFailures[0].candidateId, 'g001-L1')
    assert.equal(report.candidateFailures[0].failureCount, 3)
    assert.equal(report.candidateFailures[0].failedTasks, 3)
    assert.equal(report.candidateFailures[1].candidateId, 'g002-L1')
    assert.equal(report.candidateFailures[1].failureCount, 1)
    assert.equal(report.candidateFailures[1].failedTasks, 1)
  })

  it('区分不同类型的失败原因', () => {
    const tracker = createTaskFailureTracker()

    tracker.recordTaskFailure({
      generation: 1,
      candidateId: 'g001-L1',
      partition: 'feedback',
      instanceId: 'task-001',
      reward: 0,
      status: 'error',
      failureKind: 'infrastructure',
      reasonCode: 'model_provider_failure',
    })
    tracker.recordTaskFailure({
      generation: 2,
      candidateId: 'g002-L1',
      partition: 'feedback',
      instanceId: 'task-002',
      reward: 0,
      status: 'error',
      failureKind: 'candidate',
      reasonCode: 'timeout',
    })
    tracker.recordTaskFailure({
      generation: 3,
      candidateId: 'g003-L1',
      partition: 'feedback',
      instanceId: 'task-003',
      reward: 0,
      status: 'error',
      failureKind: 'candidate',
      reasonCode: 'invalid_output',
    })

    const report = tracker.generateReport()
    assert.equal(report.summary.byFailureKind.infrastructure, 1)
    assert.equal(report.summary.byFailureKind.candidate, 2)
    assert.equal(report.summary.byReasonCode.model_provider_failure, 1)
    assert.equal(report.summary.byReasonCode.timeout, 1)
    assert.equal(report.summary.byReasonCode.invalid_output, 1)
  })

  it('识别始终失败的题目', () => {
    const tracker = createTaskFailureTracker()

    // task-001 在所有 3 代都失败
    for (let gen = 1; gen <= 3; gen++) {
      tracker.recordTaskFailure({
        generation: gen,
        candidateId: `g00${gen}-L1`,
        partition: 'feedback',
        instanceId: 'task-001',
        reward: 0,
        status: 'error',
        failureKind: 'candidate',
      })
    }

    // task-002 只在第 1 代失败
    tracker.recordTaskFailure({
      generation: 1,
      candidateId: 'g001-L1',
      partition: 'feedback',
      instanceId: 'task-002',
      reward: 0,
      status: 'error',
      failureKind: 'candidate',
    })

    const report = tracker.generateReport()
    assert.equal(report.crossGenerationAnalysis.alwaysFailingTasks.length, 1)
    assert.equal(report.crossGenerationAnalysis.alwaysFailingTasks[0].instanceId, 'task-001')
    assert.equal(report.crossGenerationAnalysis.alwaysFailingTasks[0].failureCount, 3)
    assert.deepEqual(report.crossGenerationAnalysis.alwaysFailingTasks[0].generations, [1, 2, 3])
  })

  it('识别新增失败的题目', () => {
    const tracker = createTaskFailureTracker()

    // task-001 在第 1 代失败
    tracker.recordTaskFailure({
      generation: 1,
      candidateId: 'g001-L1',
      partition: 'feedback',
      instanceId: 'task-001',
      reward: 0,
      status: 'error',
      failureKind: 'candidate',
    })

    // task-002 在第 2、3 代才失败（新增失败）
    tracker.recordTaskFailure({
      generation: 2,
      candidateId: 'g002-L1',
      partition: 'feedback',
      instanceId: 'task-002',
      reward: 0,
      status: 'error',
      failureKind: 'candidate',
    })
    tracker.recordTaskFailure({
      generation: 3,
      candidateId: 'g003-L1',
      partition: 'feedback',
      instanceId: 'task-002',
      reward: 0,
      status: 'error',
      failureKind: 'candidate',
    })

    const report = tracker.generateReport()
    assert.equal(report.crossGenerationAnalysis.newlyFailingTasks.length, 1)
    assert.equal(report.crossGenerationAnalysis.newlyFailingTasks[0].instanceId, 'task-002')
    assert.equal(report.crossGenerationAnalysis.newlyFailingTasks[0].firstFailedGeneration, 2)
  })

  it('识别已改善的题目', () => {
    const tracker = createTaskFailureTracker()

    // task-001 在第 1、2 代失败，第 3 代成功（改善）
    tracker.recordTaskFailure({
      generation: 1,
      candidateId: 'g001-L1',
      partition: 'feedback',
      instanceId: 'task-001',
      reward: 0,
      status: 'error',
      failureKind: 'candidate',
    })
    tracker.recordTaskFailure({
      generation: 2,
      candidateId: 'g002-L1',
      partition: 'feedback',
      instanceId: 'task-001',
      reward: 0,
      status: 'error',
      failureKind: 'candidate',
    })

    // task-002 在第 3 代失败
    tracker.recordTaskFailure({
      generation: 3,
      candidateId: 'g003-L1',
      partition: 'feedback',
      instanceId: 'task-002',
      reward: 0,
      status: 'error',
      failureKind: 'candidate',
    })

    const report = tracker.generateReport()
    assert.equal(report.crossGenerationAnalysis.improvedTasks.length, 1)
    assert.equal(report.crossGenerationAnalysis.improvedTasks[0].instanceId, 'task-001')
    assert.equal(report.crossGenerationAnalysis.improvedTasks[0].lastFailedGeneration, 2)
  })

  it('生成人类可读的失败报告', () => {
    const tracker = createTaskFailureTracker()

    // 始终失败的题目
    for (let gen = 1; gen <= 3; gen++) {
      tracker.recordTaskFailure({
        generation: gen,
        candidateId: `g00${gen}-L1`,
        partition: 'feedback',
        instanceId: 'task-hard',
        reward: 0,
        status: 'error',
        failureKind: 'candidate',
        reasonCode: 'logic_error',
      })
    }

    // 新增失败的题目
    tracker.recordTaskFailure({
      generation: 3,
      candidateId: 'g003-L1',
      partition: 'feedback',
      instanceId: 'task-regressed',
      reward: 0,
      status: 'error',
      failureKind: 'candidate',
      reasonCode: 'timeout',
    })

    const reportText = tracker.generateReportText()
    assert.ok(reportText.includes('📊 题目失败统计报告'))
    assert.ok(reportText.includes('总失败次数：4'))
    assert.ok(reportText.includes('失败题目数：2'))
    assert.ok(reportText.includes('🔴 始终失败：1 道题'))
    assert.ok(reportText.includes('🟡 新增失败：1 道题'))
    assert.ok(reportText.includes('task-hard'))
    assert.ok(reportText.includes('task-regressed'))
  })

  it('获取高优先级失败题目列表', () => {
    const tracker = createTaskFailureTracker()

    // 始终失败的题目（最高优先级）
    for (let gen = 1; gen <= 3; gen++) {
      tracker.recordTaskFailure({
        generation: gen,
        candidateId: `g00${gen}-L1`,
        partition: 'feedback',
        instanceId: 'task-always-fail',
        reward: 0,
        status: 'error',
        failureKind: 'candidate',
      })
    }

    // 新增失败的题目
    tracker.recordTaskFailure({
      generation: 3,
      candidateId: 'g003-L1',
      partition: 'feedback',
      instanceId: 'task-newly-fail',
      reward: 0,
      status: 'error',
      failureKind: 'candidate',
    })

    // 其他失败题目
    tracker.recordTaskFailure({
      generation: 2,
      candidateId: 'g002-L1',
      partition: 'feedback',
      instanceId: 'task-other',
      reward: 0,
      status: 'error',
      failureKind: 'candidate',
    })

    const priorityTasks = tracker.getPriorityFailedTasks(10)
    assert.ok(priorityTasks.length >= 3)

    // 验证优先级排序
    assert.equal(priorityTasks[0].instanceId, 'task-always-fail')
    assert.equal(priorityTasks[0].priority, 'always-failing')
    assert.equal(priorityTasks[1].instanceId, 'task-newly-fail')
    assert.equal(priorityTasks[1].priority, 'newly-failing')
  })
})
