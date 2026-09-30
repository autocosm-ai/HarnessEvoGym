import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createUpdaterFailureTracker } from '../src/updater-failure-tracker.mjs'

describe('Updater Failure Tracker', () => {
  it('初始状态无失败记录', () => {
    const tracker = createUpdaterFailureTracker()
    const report = tracker.generateReport()
    assert.equal(report.summary.totalFailures, 0)
    assert.equal(report.failures.length, 0)
  })

  it('记录单个失败', () => {
    const tracker = createUpdaterFailureTracker()
    tracker.recordFailure({
      generation: 1,
      candidateId: 'g001-L1',
      parentId: 'H0',
      mutationPlanId: 'plan-001',
      regionIds: ['region-a'],
      stage: 'update-and-diff',
      message: 'Docker 启动失败',
      details: ['Connection refused'],
      candidateDigest: null,
    })

    const report = tracker.generateReport()
    assert.equal(report.summary.totalFailures, 1)
    assert.equal(report.summary.byStage['update-and-diff'], 1)
    assert.equal(report.failures.length, 1)
    assert.equal(report.failures[0].generation, 1)
    assert.equal(report.failures[0].candidateId, 'g001-L1')
    assert.equal(report.failures[0].message, 'Docker 启动失败')
  })

  it('记录多个失败并按 generation 分组统计', () => {
    const tracker = createUpdaterFailureTracker()
    tracker.recordFailure({
      generation: 1,
      candidateId: 'g001-L1',
      parentId: 'H0',
      mutationPlanId: 'plan-001',
      regionIds: ['region-a'],
      stage: 'update-and-diff',
      message: '失败 1',
      details: [],
      candidateDigest: null,
    })
    tracker.recordFailure({
      generation: 2,
      candidateId: 'g002-L1',
      parentId: 'g001-L1',
      mutationPlanId: 'plan-002',
      regionIds: ['region-b'],
      stage: 'update-and-diff',
      message: '失败 2',
      details: [],
      candidateDigest: 'abc123',
    })
    tracker.recordFailure({
      generation: 2,
      candidateId: 'g002-L2',
      parentId: 'g001-L1',
      mutationPlanId: 'plan-003',
      regionIds: ['region-c'],
      stage: 'validation',
      message: '失败 3',
      details: [],
      candidateDigest: null,
    })

    const report = tracker.generateReport()
    assert.equal(report.summary.totalFailures, 3)
    assert.equal(report.summary.byStage['update-and-diff'], 2)
    assert.equal(report.summary.byStage['validation'], 1)
    assert.equal(report.summary.byGeneration[1], 1)
    assert.equal(report.summary.byGeneration[2], 2)
    assert.equal(report.failures.length, 3)
  })

  it('失败记录包含完整上下文信息', () => {
    const tracker = createUpdaterFailureTracker()
    tracker.recordFailure({
      generation: 5,
      candidateId: 'g005-L2',
      parentId: 'g004-L1',
      mutationPlanId: 'plan-abc',
      regionIds: ['skills/analysis', 'runtime/io'],
      stage: 'update-and-diff',
      message: 'Diff 校验失败：逃逸 Mutation Region',
      details: ['unauthorized: src/controller.mjs'],
      candidateDigest: 'def456',
    })

    const report = tracker.generateReport()
    const failure = report.failures[0]
    assert.equal(failure.generation, 5)
    assert.equal(failure.candidateId, 'g005-L2')
    assert.equal(failure.parentId, 'g004-L1')
    assert.equal(failure.mutationPlanId, 'plan-abc')
    assert.deepEqual(failure.regionIds, ['skills/analysis', 'runtime/io'])
    assert.equal(failure.stage, 'update-and-diff')
    assert.equal(failure.message, 'Diff 校验失败：逃逸 Mutation Region')
    assert.deepEqual(failure.details, ['unauthorized: src/controller.mjs'])
    assert.equal(failure.candidateDigest, 'def456')
    assert.ok(failure.timestamp)
  })

  it('记录增强失败信息（错误类型、退出码、超时）', () => {
    const tracker = createUpdaterFailureTracker()
    tracker.recordFailure({
      generation: 3,
      candidateId: 'g003-L1',
      parentId: 'g002-L1',
      mutationPlanId: 'plan-003',
      regionIds: ['region-x'],
      stage: 'updater-timeout',
      message: 'Updater 执行超时',
      details: ['执行超时', '退出码：124'],
      candidateDigest: null,
      errorType: 'infrastructure',
      exitCode: 124,
      timedOut: true,
    })

    const report = tracker.generateReport()
    const failure = report.failures[0]
    assert.equal(failure.errorType, 'infrastructure')
    assert.equal(failure.exitCode, 124)
    assert.equal(failure.timedOut, true)

    const summary = report.summary
    assert.equal(summary.byErrorType['infrastructure'], 1)
    assert.equal(summary.timeouts, 1)
  })

  it('统计超时失败次数', () => {
    const tracker = createUpdaterFailureTracker()
    tracker.recordFailure({
      generation: 1,
      candidateId: 'g001-L1',
      parentId: 'H0',
      mutationPlanId: 'plan-001',
      regionIds: ['region-a'],
      stage: 'updater-timeout',
      message: '超时 1',
      details: [],
      candidateDigest: null,
      timedOut: true,
    })
    tracker.recordFailure({
      generation: 2,
      candidateId: 'g002-L1',
      parentId: 'g001-L1',
      mutationPlanId: 'plan-002',
      regionIds: ['region-b'],
      stage: 'updater-execution',
      message: '普通失败',
      details: [],
      candidateDigest: null,
      timedOut: false,
    })
    tracker.recordFailure({
      generation: 3,
      candidateId: 'g003-L1',
      parentId: 'g002-L1',
      mutationPlanId: 'plan-003',
      regionIds: ['region-c'],
      stage: 'updater-timeout',
      message: '超时 2',
      details: [],
      candidateDigest: null,
      timedOut: true,
    })

    const summary = tracker.getSummary()
    assert.equal(summary.totalFailures, 3)
    assert.equal(summary.timeouts, 2)
  })

  it('按错误类型分组统计', () => {
    const tracker = createUpdaterFailureTracker()
    tracker.recordFailure({
      generation: 1,
      candidateId: 'g001-L1',
      parentId: 'H0',
      mutationPlanId: 'plan-001',
      regionIds: ['region-a'],
      stage: 'updater-execution',
      message: '基础设施失败',
      details: [],
      candidateDigest: null,
      errorType: 'infrastructure',
    })
    tracker.recordFailure({
      generation: 2,
      candidateId: 'g002-L1',
      parentId: 'g001-L1',
      mutationPlanId: 'plan-002',
      regionIds: ['region-b'],
      stage: 'update-and-diff',
      message: 'Updater 失败',
      details: [],
      candidateDigest: null,
      errorType: 'updater_failure',
    })
    tracker.recordFailure({
      generation: 3,
      candidateId: 'g003-L1',
      parentId: 'g002-L1',
      mutationPlanId: 'plan-003',
      regionIds: ['region-c'],
      stage: 'updater-execution',
      message: '又一次基础设施失败',
      details: [],
      candidateDigest: null,
      errorType: 'infrastructure',
    })

    const summary = tracker.getSummary()
    assert.equal(summary.byErrorType['infrastructure'], 2)
    assert.equal(summary.byErrorType['updater_failure'], 1)
  })

  it('生成人类可读报告包含增强信息', () => {
    const tracker = createUpdaterFailureTracker()
    tracker.recordFailure({
      generation: 1,
      candidateId: 'g001-L1',
      parentId: 'H0',
      mutationPlanId: 'plan-001',
      regionIds: ['region-a'],
      stage: 'updater-timeout',
      message: 'Updater 超时',
      details: ['执行超时', '退出码：124'],
      candidateDigest: null,
      errorType: 'infrastructure',
      exitCode: 124,
      timedOut: true,
    })

    const reportText = tracker.generateReportText()
    assert.ok(reportText.includes('⚠️  Updater 失败统计'))
    assert.ok(reportText.includes('按错误类型分类'))
    assert.ok(reportText.includes('infrastructure'))
    assert.ok(reportText.includes('超时失败：1 次'))
    assert.ok(reportText.includes('Exit Code: 124'))
    assert.ok(reportText.includes('⏱️  Timeout'))
  })
})
