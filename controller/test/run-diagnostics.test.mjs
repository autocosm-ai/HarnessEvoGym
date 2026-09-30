import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createRunDiagnostics } from '../src/run-diagnostics.mjs'

async function json(pathValue) {
  return JSON.parse(await readFile(pathValue, 'utf8'))
}

function state() {
  return {
    spec: {
      searchHistory: [{ generation: 1, proposalId: 'g001-l1', status: 'promoted', selection: { eligible: true } }],
    },
  }
}

test('Run Diagnostics 记录合法零分、基础设施失败、Token 和可读报告，并恢复快照', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-run-diagnostics-'))
  const diagnostics = createRunDiagnostics({ secrets: ['sk-secret-value'] })
  diagnostics.monitor.recordTokenUsage({ role: 'solver', promptTokens: 3, completionTokens: 4 })
  diagnostics.observeRecords({
    generation: 1,
    candidateId: 'g001-l1',
    partition: 'selection',
    records: new Map([
      ['correct-zero', { status: 'resolved', reward: 0, solverFailures: [] }],
      ['provider-failure', {
        status: 'error', reward: 0,
        solverFailures: [{ failureKind: 'provider', reasonCode: 'upstream-stream-interrupted' }],
      }],
    ]),
  })
  const error = Object.assign(new Error('gateway sk-secret-value failed'), {
    name: 'UpdaterRunError', kind: 'infrastructure', stage: 'updater-execution',
    result: { exitCode: 1, timedOut: false },
  })
  diagnostics.updaterFailure({ error, generation: 1, candidateId: 'g001-l1', message: 'sk-secret-value' })
  await diagnostics.persist({
    state: state(), runRoot: root,
    solverUsage: { inputTokens: 5, outputTokens: 6 },
    updaterUsage: { inputTokens: 7, outputTokens: 8 },
  })

  const taskReport = await json(join(root, 'task-failures.json'))
  assert.equal(taskReport.summary.totalFailures, 1)
  assert.equal(taskReport.taskFailures[0].instanceId, 'provider-failure')
  assert.equal((await readFile(join(root, 'evolution-monitor.txt'), 'utf8')).includes('总计'), true)
  const updaterText = await readFile(join(root, 'updater-failures.txt'), 'utf8')
  assert.equal(updaterText.includes('sk-secret-value'), false)
  const monitor = await json(join(root, 'evolution-monitor.json'))
  assert.equal(monitor.summary.tokenUsage.total.total, 26)

  const resumed = createRunDiagnostics({
    snapshot: (await json(join(root, 'state.json'))).spec.diagnostics,
    secrets: ['sk-secret-value'],
  })
  assert.equal(resumed.monitor.tokenUsage.total.total, 26)
  await resumed.persist({
    state: state(), runRoot: root,
    solverUsage: { inputTokens: 1, outputTokens: 2 },
    updaterUsage: { inputTokens: 3, outputTokens: 4 },
  })
  assert.equal((await json(join(root, 'evolution-monitor.json'))).summary.tokenUsage.total.total, 36)
})
