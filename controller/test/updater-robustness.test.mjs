import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  calculateUpdaterTimeout,
  validateMutationReportEnhanced,
  validateDiffSafety,
  diagnoseUpdaterFailure,
  createUpdaterHistoryTracker,
} from '../src/updater-robustness.mjs'

describe('Updater Robustness', () => {
  describe('calculateUpdaterTimeout', () => {
    it('基础超时按 mutation level 递增', () => {
      const l1Timeout = calculateUpdaterTimeout({ mutationLevel: 'l1', baseTimeoutSeconds: 1800 })
      const l2Timeout = calculateUpdaterTimeout({ mutationLevel: 'l2', baseTimeoutSeconds: 1800 })
      const l3Timeout = calculateUpdaterTimeout({ mutationLevel: 'l3', baseTimeoutSeconds: 1800 })

      assert.ok(l1Timeout < l2Timeout)
      assert.ok(l2Timeout < l3Timeout)
      assert.equal(l1Timeout, 1800)  // 1.0x
      assert.equal(l2Timeout, 2700)  // 1.5x
      assert.equal(l3Timeout, 3600)  // 2.0x, capped at maxTimeout
    })

    it('基于历史数据调整超时时间', () => {
      const historicalDurations = [300_000, 350_000, 400_000, 450_000, 500_000] // 5-8.3 分钟
      const timeout = calculateUpdaterTimeout({
        mutationLevel: 'l1',
        baseTimeoutSeconds: 600,
        historicalDurations,
        safetyFactor: 1.5,
      })

      // P95 = 500000ms = 500s, * 1.5 = 750s
      assert.ok(timeout >= 750)
    })

    it('超时时间受最小值和最大值限制', () => {
      const tooLow = calculateUpdaterTimeout({ mutationLevel: 'l1', baseTimeoutSeconds: 100 })
      const tooHigh = calculateUpdaterTimeout({ mutationLevel: 'l3', baseTimeoutSeconds: 5000 })

      assert.ok(tooLow >= 300)   // min 5 min
      assert.ok(tooHigh <= 3600) // max 60 min
    })
  })

  describe('validateMutationReportEnhanced', () => {
    it('验证通过：完整的 report', () => {
      const report = {
        diagnosis: '当前 L1 prompt 在处理多步推理时未引导模型分解子问题，导致复杂题目推理链断裂。',
        hypothesis: '在 system prompt 中增加"逐步分解复杂问题"的指导，要求模型先识别子问题再依次求解。',
        expectedImpact: '预期提升多步推理题目的 reward，从 0.65 提升到 0.75 左右。',
        remainingRisks: '可能增加 token 消耗，需要监控成本变化。',
        changedFiles: ['prompts/solver-l1.md'],
      }

      const result = validateMutationReportEnhanced(report)
      assert.equal(result.valid, true)
      assert.equal(result.errors.length, 0)
    })

    it('检测字段过短', () => {
      const report = {
        diagnosis: '太短',
        hypothesis: '改 prompt',
        expectedImpact: '提升',
        remainingRisks: '无',
        changedFiles: ['prompts/solver-l1.md'],
      }

      const result = validateMutationReportEnhanced(report)
      // 字段过短产生 warnings，不影响 valid
      assert.ok(result.warnings.some((w) => w.includes('diagnosis')))
      assert.ok(result.warnings.some((w) => w.includes('hypothesis')))
    })

    it('检测占位符内容', () => {
      const report = {
        diagnosis: 'TODO: 需要进一步分析根本原因，当前还不清楚为什么会失败。',
        hypothesis: '待补充具体改进方案',
        expectedImpact: 'TBD',
        remainingRisks: 'FIXME: 补充风险评估',
        changedFiles: ['prompts/solver-l1.md'],
      }

      const result = validateMutationReportEnhanced(report)
      assert.equal(result.valid, false)
      assert.ok(result.errors.some((e) => e.includes('TODO')))
    })

    it('检测 changedFiles 为空', () => {
      const report = {
        diagnosis: '当前 prompt 存在问题',
        hypothesis: '修改 prompt',
        expectedImpact: '提升 reward',
        remainingRisks: '无明显风险',
        changedFiles: [],
      }

      const result = validateMutationReportEnhanced(report)
      assert.equal(result.valid, false)
      assert.ok(result.errors.some((e) => e.includes('changedFiles 为空')))
    })

    it('警告 changedFiles 数量过多', () => {
      const report = {
        diagnosis: '需要大规模重构所有 prompt 文件以统一风格',
        hypothesis: '批量修改所有 prompt',
        expectedImpact: '提升整体一致性',
        remainingRisks: '改动范围大，可能引入新问题',
        changedFiles: Array.from({ length: 150 }, (_, i) => `file${i}.md`),
      }

      const result = validateMutationReportEnhanced(report)
      assert.ok(result.warnings.some((w) => w.includes('数量过多')))
    })
  })

  describe('validateDiffSafety', () => {
    it('非法 Diff 记录按安全失败返回，不抛 TypeError', () => {
      const result = validateDiffSafety([
        { before: { kind: 'file' }, after: null },
        { path: '../outside', before: null, after: { kind: 'file' } },
      ], {
        diagnosis: '检查异常输入',
        hypothesis: '拒绝越界 Diff',
        changedFiles: [],
      })
      assert.equal(result.safe, false)
      assert.ok(result.errors.some((error) => error.includes('path')))
    })

    it('检测删除关键文件', () => {
      const changes = [
        { path: 'package.json', before: { kind: 'file' }, after: null },
        { path: 'src/index.js', before: { kind: 'file' }, after: { kind: 'file' } },
      ]
      const report = {
        diagnosis: '修改入口文件',
        hypothesis: '优化启动逻辑',
        changedFiles: ['src/index.js'],
      }

      const result = validateDiffSafety(changes, report)
      assert.ok(result.warnings.some((w) => w.includes('删除关键文件')))
    })

    it('检测删除操作未在 report 中说明', () => {
      const changes = [
        { path: 'old-file.js', before: { kind: 'file' }, after: null },
        { path: 'new-file.js', before: null, after: { kind: 'file' } },
      ]
      const report = {
        diagnosis: '添加新功能',
        hypothesis: '实现新逻辑',
        changedFiles: ['new-file.js'],
      }

      const result = validateDiffSafety(changes, report)
      assert.ok(result.warnings.some((w) => w.includes('未说明原因')))
    })

    it('检测大规模重命名', () => {
      const deletions = Array.from({ length: 10 }, (_, i) => ({
        path: `old/file${i}.js`,
        before: { kind: 'file' },
        after: null,
      }))
      const additions = Array.from({ length: 10 }, (_, i) => ({
        path: `new/file${i}.js`,
        before: null,
        after: { kind: 'file' },
      }))
      const changes = [...deletions, ...additions]
      const report = {
        diagnosis: '重构目录结构',
        hypothesis: '调整文件组织',
        changedFiles: changes.map((c) => c.path),
      }

      const result = validateDiffSafety(changes, report)
      assert.ok(result.warnings.some((w) => w.includes('大规模重命名')))
    })

    it('检测配置文件修改未提及', () => {
      const changes = [
        { path: 'config.yaml', before: { kind: 'file' }, after: { kind: 'file' } },
        { path: 'settings.json', before: { kind: 'file' }, after: { kind: 'file' } },
      ]
      const report = {
        diagnosis: '优化代码逻辑',
        hypothesis: '改进算法',
        changedFiles: ['config.yaml', 'settings.json'],
      }

      const result = validateDiffSafety(changes, report)
      assert.ok(result.warnings.some((w) => w.includes('配置文件')))
    })

    it('检测二进制文件修改', () => {
      const changes = [
        { path: 'image.png', before: { kind: 'file' }, after: { kind: 'file' } },
        { path: 'data.zip', before: null, after: { kind: 'file' } },
      ]
      const report = {
        diagnosis: '更新资源文件',
        hypothesis: '替换图片',
        changedFiles: ['image.png', 'data.zip'],
      }

      const result = validateDiffSafety(changes, report)
      assert.ok(result.warnings.some((w) => w.includes('二进制文件')))
    })
  })

  describe('diagnoseUpdaterFailure', () => {
    it('诊断超时失败', () => {
      const error = {
        name: 'UpdaterRunError',
        message: 'Updater infrastructure',
        result: { timedOut: true },
        context: { timeoutMs: 1800000, mutationLevel: 'l3' },
      }
      const context = { mutationLevel: 'l3' }

      const diagnosis = diagnoseUpdaterFailure(error, context)
      assert.equal(diagnosis.failureKind, 'timeout')
      assert.ok(diagnosis.possibleCauses.length > 0)
      assert.ok(diagnosis.recommendations.length > 0)
      assert.equal(diagnosis.shouldRetry, false)
      assert.equal(diagnosis.degradationStrategy, 'skip-generation')
    })

    it('诊断输出格式错误', () => {
      const error = {
        message: 'Mutation Report 校验失败',
      }
      const context = { mutationLevel: 'l2' }

      const diagnosis = diagnoseUpdaterFailure(error, context)
      assert.equal(diagnosis.failureKind, 'invalid-output-format')
      assert.ok(diagnosis.recommendations.some((r) => r.includes('prompt')))
    })

    it('诊断 Diff 越界', () => {
      const error = {
        message: 'Updater 产生越界 Diff',
      }
      const context = { mutationLevel: 'l1' }

      const diagnosis = diagnoseUpdaterFailure(error, context)
      assert.equal(diagnosis.failureKind, 'policy-violation')
      assert.ok(diagnosis.recommendations.some((r) => r.includes('writable')))
    })

    it('诊断基础设施错误（可重试）', () => {
      const error = {
        kind: 'infrastructure',
        message: 'Docker 容器启动失败',
      }
      const context = { mutationLevel: 'l2' }

      const diagnosis = diagnoseUpdaterFailure(error, context)
      assert.equal(diagnosis.failureKind, 'infrastructure')
      assert.equal(diagnosis.shouldRetry, true)
      assert.equal(diagnosis.degradationStrategy, 'retry-once')
    })
  })

  describe('createUpdaterHistoryTracker', () => {
    it('记录执行历史', () => {
      const tracker = createUpdaterHistoryTracker()
      tracker.record({ mutationLevel: 'l1', durationMs: 300000, success: true })
      tracker.record({ mutationLevel: 'l1', durationMs: 350000, success: true })
      tracker.record({ mutationLevel: 'l1', durationMs: 400000, success: false })

      const stats = tracker.getStatistics('l1')
      assert.equal(stats.count, 3)
      assert.equal(stats.successRate, 2 / 3)
      assert.equal(stats.avgDuration, (300000 + 350000) / 2)
    })

    it('只保留最近 50 次记录', () => {
      const tracker = createUpdaterHistoryTracker()
      for (let i = 0; i < 60; i += 1) {
        tracker.record({ mutationLevel: 'l2', durationMs: 100000 + i * 1000, success: true })
      }

      const stats = tracker.getStatistics('l2')
      assert.equal(stats.count, 50)
    })

    it('getSuccessfulDurations 只返回成功的记录', () => {
      const tracker = createUpdaterHistoryTracker()
      tracker.record({ mutationLevel: 'l3', durationMs: 500000, success: true })
      tracker.record({ mutationLevel: 'l3', durationMs: 600000, success: false })
      tracker.record({ mutationLevel: 'l3', durationMs: 550000, success: true })

      const durations = tracker.getSuccessfulDurations('l3')
      assert.equal(durations.length, 2)
      assert.deepEqual(durations, [500000, 550000])
    })

    it('计算 P50 和 P95', () => {
      const tracker = createUpdaterHistoryTracker()
      for (let i = 1; i <= 100; i += 1) {
        tracker.record({ mutationLevel: 'l1', durationMs: i * 10000, success: true })
      }

      const stats = tracker.getStatistics('l1')
      assert.ok(stats.p50 > 0)
      assert.ok(stats.p95 > stats.p50)
    })
  })
})
