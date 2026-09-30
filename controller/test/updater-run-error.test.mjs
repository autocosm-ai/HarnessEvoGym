import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { UpdaterRunError } from '../src/updater-runner.mjs'

describe('UpdaterRunError', () => {
  it('基本错误信息', () => {
    const error = new UpdaterRunError('Updater failed', {
      kind: 'updater_failure',
      result: { ok: false, exitCode: 1, durationMs: 5000 },
      stage: 'updater-execution',
      context: { candidateId: 'g001-L1', generation: 1 },
    })

    assert.equal(error.name, 'UpdaterRunError')
    assert.equal(error.message, 'Updater failed')
    assert.equal(error.kind, 'updater_failure')
    assert.equal(error.stage, 'updater-execution')
    assert.deepEqual(error.context, { candidateId: 'g001-L1', generation: 1 })
  })

  it('生成结构化失败报告', () => {
    const error = new UpdaterRunError('Updater timeout', {
      kind: 'infrastructure',
      result: {
        ok: false,
        exitCode: 124,
        timedOut: true,
        durationMs: 600000,
        stderr: 'Error: Connection timeout\nTimeout reached',
      },
      stage: 'updater-timeout',
      context: { candidateId: 'g002-L2', parentId: 'g001-L1', generation: 2 },
    })

    const report = error.toFailureReport()
    assert.equal(report.stage, 'updater-timeout')
    assert.equal(report.message, 'Updater timeout')
    assert.equal(report.errorType, 'infrastructure')
    assert.equal(report.exitCode, 124)
    assert.equal(report.timedOut, true)
    assert.equal(report.durationMs, 600000)
    assert.ok(report.details.some((detail) => detail.includes('执行超时')))
    assert.ok(report.details.some((detail) => detail.includes('退出码')))
  })

  it('从 stderr 提取错误信息', () => {
    const error = new UpdaterRunError('Updater crashed', {
      kind: 'updater_failure',
      result: {
        ok: false,
        exitCode: 1,
        stderr: `Some output
Error: Docker connection failed
Another line
Exception in thread: OOM
More context
Failed to allocate memory`,
      },
      stage: 'updater-execution',
    })

    const report = error.toFailureReport()
    assert.ok(report.details.length > 0)
    assert.ok(report.details.some((detail) => detail.includes('Error')))
    assert.ok(report.details.length <= 4) // 最多 3 条错误行 + 退出码
  })

  it('处理没有 stderr 的情况', () => {
    const error = new UpdaterRunError('Unknown failure', {
      kind: 'updater_failure',
      result: { ok: false, exitCode: 1, stderr: '' },
      stage: 'updater-execution',
    })

    const report = error.toFailureReport()
    assert.equal(report.stage, 'updater-execution')
    assert.equal(report.message, 'Unknown failure')
    assert.ok(Array.isArray(report.details))
  })

  it('包含上下文信息', () => {
    const error = new UpdaterRunError('Mutation failed', {
      kind: 'updater_failure',
      result: { ok: false, exitCode: 1 },
      stage: 'update-and-diff',
      context: {
        candidateId: 'g005-L2',
        parentId: 'g004-L1',
        generation: 5,
        backend: 'deepseek-harness',
        timeoutMs: 300000,
      },
    })

    const report = error.toFailureReport()
    assert.equal(report.candidateId, 'g005-L2')
    assert.equal(report.parentId, 'g004-L1')
    assert.equal(report.generation, 5)
    assert.equal(report.backend, 'deepseek-harness')
    assert.equal(report.timeoutMs, 300000)
  })

  it('处理 aborted 信号', () => {
    const error = new UpdaterRunError('Updater aborted', {
      kind: 'infrastructure',
      result: {
        ok: false,
        aborted: true,
        signal: 'SIGTERM',
        durationMs: 12000,
      },
      stage: 'updater-aborted',
    })

    const report = error.toFailureReport()
    assert.ok(report.details.some((detail) => detail.includes('中止')))
    assert.ok(report.details.some((detail) => detail.includes('SIGTERM')))
  })
})
