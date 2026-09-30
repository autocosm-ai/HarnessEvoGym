import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
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

test('Core Engine 拒绝不可序列化或过大的事件详情', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-server-event-limit-'))
  const engine = new CoreEngine({ repositoryRoot: root, runsRoot: join(root, 'runs') })
  await engine.writeDescriptor({
    apiVersion: 'harness-evo-gym/v1',
    kind: 'CoreEngineRun',
    runId: 'event-limit-001',
    status: 'queued',
    operation: 'run',
    experimentPath: 'experiments/a.json',
    runRoot: '.rsi/event-limit-001',
    population: true,
    pid: null,
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
  })
  const circular = {}
  circular.self = circular
  await assert.rejects(() => engine.event('event-limit-001', 'bad', circular), /循环引用/u)
  await assert.rejects(() => engine.event('event-limit-001', 'bad', { value: 'x'.repeat(10_000) }), /字节上限/u)
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

test('Core Engine 可以从 Population Run 创建新的 Fork Run，并保留父子关系', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-server-fork-'))
  const calls = []
  const engine = new CoreEngine({
    repositoryRoot: REPOSITORY_ROOT,
    runsRoot: join(root, 'runs'),
    processFactory: (executable, args) => {
      calls.push({ executable, args })
      const handlers = new Map()
      return {
        pid: 4343,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        once(name, callback) { handlers.set(name, callback) },
        on() {},
        kill(signal) { handlers.get('close')?.(null, signal) },
      }
    },
  })
  await engine.writeDescriptor({
    apiVersion: 'harness-evo-gym/v1',
    kind: 'CoreEngineRun',
    runId: 'parent-pop-001',
    status: 'completed',
    operation: 'run',
    experimentPath: 'experiments/reasoning-msa-progressive-strict-smoke.json',
    runRoot: 'controller/test/fixtures',
    population: true,
    pid: null,
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
  })
  const fork = await engine.forkRun('parent-pop-001', {
    runId: 'fork-pop-001',
  })
  assert.equal(fork.operation, 'fork')
  assert.equal(fork.parentRunId, 'parent-pop-001')
  assert.equal(fork.evaluationMode, 'fork')
  assert.deepEqual(calls[0].args.slice(1, 4), ['experiment', 'fork', '--run'])
  assert.equal(calls[0].args.includes('--run-id'), true)
  assert.equal(calls[0].args.includes('fork-pop-001'), true)
  await assert.rejects(
    engine.forkRun('parent-pop-001', { runId: 'fork-pop-002', checkpoint: '/etc/passwd' }),
    /checkpoint 必须是 Parent Run 内的相对路径/u,
  )
})

test('Core Engine 不会让 close(0) 覆盖先到达的子进程 error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-server-error-race-'))
  let handlers
  const engine = new CoreEngine({
    repositoryRoot: REPOSITORY_ROOT,
    runsRoot: join(root, 'runs'),
    processFactory: () => {
      handlers = new Map()
      return {
        pid: 4545,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        once(name, callback) { handlers.set(name, callback) },
        on() {},
        kill() {},
      }
    },
  })
  const descriptor = {
    apiVersion: 'harness-evo-gym/v1',
    kind: 'CoreEngineRun',
    runId: 'error-race-001',
    status: 'queued',
    operation: 'run',
    experimentPath: 'experiments/a.json',
    runRoot: '.rsi/error-race-001',
    population: true,
    pid: null,
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
  }
  await engine.createDescriptor(descriptor)
  await engine.startProcess(descriptor, [])
  handlers.get('error')(new Error('spawn failed'))
  handlers.get('close')(0, null)
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
  const state = await engine.readDescriptor('error-race-001')
  assert.equal(state.status, 'failed')
  assert.match(state.error, /spawn failed/u)
})

test('Core Engine 不吞掉损坏的核心状态文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-server-state-'))
  const engine = new CoreEngine({ repositoryRoot: root, runsRoot: join(root, 'runs') })
  const runRoot = join(root, '.rsi', 'state-001', 'public')
  await mkdir(runRoot, { recursive: true })
  await writeFile(join(runRoot, 'state.json'), '{not-json\n')
  await assert.rejects(
    engine.readCoreState({ population: true, runRoot: '.rsi/state-001' }),
    /JSON|格式/u,
  )
})

test('Core Engine 不会把没有终态状态文件的正常退出误报为 completed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-server-missing-state-'))
  let handlers
  const engine = new CoreEngine({
    repositoryRoot: REPOSITORY_ROOT,
    runsRoot: join(root, 'runs'),
    processFactory: () => {
      handlers = new Map()
      return {
        pid: 4646,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        once(name, callback) { handlers.set(name, callback) },
        on() {},
        kill() {},
      }
    },
  })
  const descriptor = {
    apiVersion: 'harness-evo-gym/v1',
    kind: 'CoreEngineRun',
    runId: 'missing-state-001',
    status: 'queued',
    operation: 'run',
    experimentPath: 'experiments/a.json',
    runRoot: '.rsi/missing-state-001',
    population: true,
    pid: null,
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
  }
  await engine.createDescriptor(descriptor)
  await engine.startProcess(descriptor, [])
  handlers.get('close')(0, null)
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
  const state = await engine.readDescriptor('missing-state-001')
  assert.equal(state.status, 'failed')
  assert.match(state.error, /终态状态文件/u)
})
