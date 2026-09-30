import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createEvolutionMonitor } from '../src/evolution-monitor.mjs'

describe('Evolution Monitor', () => {
  it('初始化状态正确', () => {
    const monitor = createEvolutionMonitor()
    const progress = monitor.getProgress()

    assert.equal(progress.generations, 0)
    assert.equal(progress.candidates, 0)
    assert.equal(progress.promoted, 0)
    assert.equal(progress.rejected, 0)
    assert.equal(progress.invalid, 0)
    assert.equal(progress.tokenUsage, 0)
  })

  it('记录事件', () => {
    const monitor = createEvolutionMonitor()

    monitor.recordEvent({
      stage: 'initialize',
      message: '开始初始化',
    })

    monitor.recordEvent({
      stage: 'feedback',
      generation: 1,
      message: '运行 feedback partition',
    })

    const summary = monitor.generateSummary()
    assert.equal(summary.events, 2)
  })

  it('记录代数统计', () => {
    const monitor = createEvolutionMonitor()

    monitor.recordGeneration({
      generation: 1,
      candidateId: 'g001-L1',
      status: 'promoted',
      decision: { eligible: true },
    })

    monitor.recordGeneration({
      generation: 2,
      candidateId: 'g002-L1',
      status: 'rejected',
      decision: { eligible: false },
    })

    monitor.recordGeneration({
      generation: 2,
      candidateId: 'g002-L2',
      status: 'invalid-proposal',
    })

    const summary = monitor.generateSummary()
    assert.equal(summary.totalGenerations, 2)
    assert.equal(summary.totalCandidates, 3)
    assert.equal(summary.totalPromoted, 1)
    assert.equal(summary.totalRejected, 1)
    assert.equal(summary.totalInvalid, 1)
  })

  it('记录 Token 使用', () => {
    const monitor = createEvolutionMonitor()

    monitor.recordTokenUsage({
      role: 'solver',
      promptTokens: 1000,
      completionTokens: 500,
    })

    monitor.recordTokenUsage({
      role: 'updater',
      promptTokens: 2000,
      completionTokens: 800,
    })

    monitor.recordTokenUsage({
      role: 'solver',
      promptTokens: 1200,
      completionTokens: 600,
    })

    const summary = monitor.generateSummary()
    assert.equal(summary.tokenUsage.solver.prompt, 2200)
    assert.equal(summary.tokenUsage.solver.completion, 1100)
    assert.equal(summary.tokenUsage.solver.total, 3300)
    assert.equal(summary.tokenUsage.updater.prompt, 2000)
    assert.equal(summary.tokenUsage.updater.completion, 800)
    assert.equal(summary.tokenUsage.updater.total, 2800)
    assert.equal(summary.tokenUsage.total.total, 6100)
  })

  it('记录阶段耗时', async () => {
    const monitor = createEvolutionMonitor()

    monitor.startPhase('feedback')
    await new Promise((resolve) => setTimeout(resolve, 50))
    monitor.endPhase()

    monitor.startPhase('update')
    await new Promise((resolve) => setTimeout(resolve, 30))
    monitor.endPhase()

    monitor.startPhase('feedback')
    await new Promise((resolve) => setTimeout(resolve, 40))
    monitor.endPhase()

    const summary = monitor.generateSummary()
    assert.ok(summary.phaseTimings.feedback)
    assert.equal(summary.phaseTimings.feedback.count, 2)
    assert.ok(summary.phaseTimings.feedback.average >= 40)
    assert.ok(summary.phaseTimings.update)
    assert.equal(summary.phaseTimings.update.count, 1)
  })

  it('生成人类可读报告', () => {
    const monitor = createEvolutionMonitor()

    monitor.recordGeneration({
      generation: 1,
      candidateId: 'g001-L1',
      status: 'promoted',
    })

    monitor.recordTokenUsage({
      role: 'solver',
      promptTokens: 5000,
      completionTokens: 2000,
    })

    const report = monitor.generateReport()
    assert.ok(report.includes('📊 Evolution 运行监控报告'))
    assert.ok(report.includes('总代数：1'))
    assert.ok(report.includes('总 Candidate 数：1'))
    assert.ok(report.includes('Token 使用统计'))
    assert.ok(report.includes('7,000'))
  })

  it('获取实时进度', () => {
    const monitor = createEvolutionMonitor()

    monitor.startPhase('feedback')
    monitor.recordGeneration({
      generation: 1,
      candidateId: 'g001-L1',
      status: 'promoted',
    })

    const progress = monitor.getProgress()
    assert.equal(progress.generations, 1)
    assert.equal(progress.candidates, 1)
    assert.equal(progress.promoted, 1)
    assert.equal(progress.currentPhase, 'feedback')
  })

  it('Generation 统计包含耗时', async () => {
    const monitor = createEvolutionMonitor()

    monitor.recordGeneration({
      generation: 1,
      candidateId: 'g001-L1',
      status: 'promoted',
    })

    await new Promise((resolve) => setTimeout(resolve, 60))

    monitor.recordGeneration({
      generation: 1,
      candidateId: 'g001-L2',
      status: 'rejected',
    })

    const summary = monitor.generateSummary()
    const gen1 = summary.generationSummary.find((g) => g.generation === 1)
    assert.ok(gen1)
    assert.equal(gen1.candidates, 2)
    assert.ok(gen1.duration >= 50, `Expected duration >= 50ms, got ${gen1.duration}ms`)
  })

  it('忽略无效 role 的 Token 记录', () => {
    const monitor = createEvolutionMonitor()

    monitor.recordTokenUsage({
      role: 'invalid',
      promptTokens: 1000,
      completionTokens: 500,
    })

    const summary = monitor.generateSummary()
    assert.equal(summary.tokenUsage.total.total, 0)
  })
})
