import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { REPOSITORY_ROOT } from '../../controller/src/config.mjs'
import { CoreEngine, assertRunId, publicDescriptor } from '../src/core-engine.mjs'

test('Core Engine 只接受安全 Run ID，并且 API 投影不会泄露运行中的 pid', () => {
  assert.throws(() => assertRunId('../escape'), /Run ID/u)
  assert.throws(() => assertRunId('ab'), /Run ID/u)
  const projected = publicDescriptor({
    apiVersion: 'harness-evo-gym/v1',
    kind: 'CoreEngineRun',
    runId: 'safe-run-001',
    status: 'completed',
    operation: 'run',
    experimentPath: 'experiments/a.json',
    runRoot: '.rsi/a',
    population: true,
    pid: 123,
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:01.000Z',
  })
  assert.equal(projected.pid, null)
})

test('Core Engine 的事件日志按追加顺序持久化', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-server-engine-'))
  const engine = new CoreEngine({ repositoryRoot: root, runsRoot: join(root, 'runs') })
  await engine.writeDescriptor({
    apiVersion: 'harness-evo-gym/v1',
    kind: 'CoreEngineRun',
    runId: 'safe-run-001',
    status: 'queued',
    operation: 'run',
    experimentPath: 'experiments/a.json',
    runRoot: '.rsi/a',
    population: true,
    pid: null,
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
  })
  await engine.event('safe-run-001', 'run.queued')
  await engine.event('safe-run-001', 'run.started', { pid: null })
  const events = await engine.getEvents('safe-run-001')
  assert.deepEqual(events.map((event) => event.sequence), [1, 2])
  const lines = (await readFile(join(root, 'runs', 'safe-run-001.events.jsonl'), 'utf8')).trim().split(/\r?\n/u)
  assert.equal(JSON.parse(lines[0]).type, 'run.queued')
})

test('Core Engine 只用仓库内 Experiment 启动受信 CLI，并可取消子进程', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-server-run-'))
  let child
  const engine = new CoreEngine({
    repositoryRoot: REPOSITORY_ROOT,
    runsRoot: join(root, 'runs'),
    processFactory: () => {
      const handlers = new Map()
      child = {
        pid: 4242,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        once(name, callback) { handlers.set(name, callback) },
        on() {},
        kill(signal) { handlers.get('close')?.(null, signal) },
      }
      return child
    },
  })
  const run = await engine.createRun({
    experimentPath: 'experiments/reasoning-msa-progressive-strict-smoke.json',
    runId: 'api-run-001',
  })
  assert.equal(run.status, 'running')
  assert.equal(run.population, true)
  await assert.rejects(
    engine.createRun({ experimentPath: '../outside.json', runId: 'api-run-002' }),
    /Experiment 路径.*逃逸受控目录/u,
  )
  await engine.controlRun('api-run-001', 'cancel')
  assert.equal(child !== null, true)
})
