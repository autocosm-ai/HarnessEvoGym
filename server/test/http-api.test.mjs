import assert from 'node:assert/strict'
import test from 'node:test'

import { createServer } from '../src/http-api.mjs'

async function withServer(engine, callback) {
  const server = createServer({ engine, versionInfo: { version: '9.9.9' } })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  try {
    return await callback(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

function fakeEngine() {
  const run = {
    apiVersion: 'harness-evo-gym/v1',
    kind: 'CoreEngineRun',
    runId: 'demo-run-001',
    status: 'running',
    operation: 'run',
  }
  return {
    async listRuns() { return [run] },
    async createRun(input) { return { ...run, experimentPath: input.experimentPath } },
    async forkRun(parentRunId, input) {
      return { ...run, runId: input.runId ?? 'fork-run-001', operation: 'fork', parentRunId }
    },
    async getRun(runId) { assert.equal(runId, run.runId); return run },
    async controlRun(runId, action) { return { ...run, runId, action } },
    async getEvents() { return [{ sequence: 1, type: 'run.started', runId: run.runId }] },
    async getVersions() { return { apiVersion: 'harness-evo-gym/v1', kind: 'RunVersions', runId: run.runId, best: null, branches: [] } },
  }
}

test('Server API 暴露健康、版本、Run、事件和版本查询', async () => {
  await withServer(fakeEngine(), async (base) => {
    const health = await fetch(`${base}/healthz`)
    assert.equal(health.status, 200)
    assert.equal((await health.json()).ok, true)

    const version = await fetch(`${base}/v1/version`)
    assert.equal((await version.json()).version, '9.9.9')

    const created = await fetch(`${base}/v1/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ experimentPath: 'experiments/demo.json' }),
    })
    assert.equal(created.status, 202)
    assert.equal((await created.json()).experimentPath, 'experiments/demo.json')

    const fork = await fetch(`${base}/v1/runs/demo-run-001/fork`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'fork-run-001', checkpoint: 'checkpoints/budget-4.json' }),
    })
    const forkBody = await fork.json()
    assert.equal(fork.status, 202)
    assert.equal(forkBody.operation, 'fork')
    assert.equal(forkBody.parentRunId, 'demo-run-001')

    const status = await fetch(`${base}/v1/runs/demo-run-001`)
    assert.equal((await status.json()).status, 'running')

    const events = await fetch(`${base}/v1/runs/demo-run-001/events`)
    assert.equal((await events.json()).events.length, 1)

    const sse = await fetch(`${base}/v1/runs/demo-run-001/events`, { headers: { accept: 'text/event-stream' } })
    assert.equal(sse.headers.get('content-type'), 'text/event-stream; charset=utf-8')
    assert.match(await sse.text(), /event: run/u)

    const action = await fetch(`${base}/v1/runs/demo-run-001/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'refresh' }),
    })
    assert.equal((await action.json()).action, 'refresh')

    const versions = await fetch(`${base}/v1/runs/demo-run-001/versions`)
    assert.equal((await versions.json()).kind, 'RunVersions')
  })
})

test('Server API 拒绝未知路由和非法 JSON', async () => {
  await withServer(fakeEngine(), async (base) => {
    assert.equal((await fetch(`${base}/nope`)).status, 404)
    const response = await fetch(`${base}/v1/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).kind, 'Error')
  })
})
