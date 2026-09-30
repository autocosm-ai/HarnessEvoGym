import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  FileAlgorithmRunStore,
  createGenericEvolutionAlgorithmDriver,
  registerGenericEvolutionAlgorithm,
  runGenericEvolution,
} from '../src/generic-algorithm.mjs'

function driver(root) {
  const store = new FileAlgorithmRunStore(root)
  return {
    store,
    checkpointCodec: {
      version: 'v1',
      encode(value) { return { privateState: value.privateState } },
      decode(value) { return value.privateState },
    },
    async initialize({ state }) { return { ...state, algorithm: 'beam', status: 'active', privateState: { frontier: ['root'] } } },
    async resume({ state }) { return state },
    async step({ state }) {
      const step = (state.step ?? 0) + 1
      return {
        state: { ...state, step, status: step >= 2 ? 'completed' : 'active' },
        checkpoint: { privateState: { frontier: [`node-${step}`] } },
        event: { type: 'algorithm.step', step },
      }
    },
    async report({ state }) { return { algorithm: state.algorithm, steps: state.step } },
    async freezeBaseline({ state }) { return state },
  }
}

test('通用 Algorithm Runner 不要求 PopulationStore，可保存私有状态和 Checkpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-generic-algorithm-'))
  const result = await runGenericEvolution({ driver: driver(join(root, 'run')), maxSteps: 4 })
  assert.equal(result.complete, true)
  assert.deepEqual(result.report, { algorithm: 'beam', steps: 2 })
  assert.equal((await result.state).status, 'completed')
  const checkpoint = await result.state
  assert.equal(checkpoint.step, 2)
  const stored = await driver(join(root, 'run')).store.readCheckpoint('step-000001.json')
  assert.equal(stored.version, 'v1')
})

test('通用 Algorithm Registry 可以注册完全不同的状态结构', async () => {
  registerGenericEvolutionAlgorithm('fixture-mcts-v1', ({ store }) => ({
    ...driver(store.root),
    store,
  }))
  const root = await mkdtemp(join(tmpdir(), 'harness-generic-registry-'))
  const store = new FileAlgorithmRunStore(join(root, 'run'))
  const created = createGenericEvolutionAlgorithmDriver({
    algorithm: { id: 'fixture-mcts-v1', configuration: { exploration: 1.4 } },
    options: { store },
  })
  assert.equal(created.store, store)
  assert.equal(typeof created.step, 'function')
})

test('通用 Algorithm Runner 的 Baseline-only 生命周期不会偷偷推进搜索步', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-generic-baseline-'))
  let steps = 0
  const base = driver(join(root, 'run'))
  const wrapped = {
    ...base,
    async step(input) {
      steps += 1
      return await base.step(input)
    },
    async freezeBaseline({ state }) { return { ...state, status: 'completed', baseline: true } },
  }
  const result = await runGenericEvolution({ driver: wrapped, baselineOnly: true, maxSteps: 8 })
  assert.equal(steps, 0)
  assert.equal(result.state.baseline, true)
  assert.equal(result.complete, true)
})

test('通用 Algorithm Runner Resume 不会覆盖前一次 Run 的不可变 Checkpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-generic-resume-'))
  const first = await runGenericEvolution({ driver: driver(join(root, 'run')), maxSteps: 1 })
  assert.equal(first.complete, false)
  const resumed = await runGenericEvolution({
    driver: driver(join(root, 'run')),
    maxSteps: 2,
    resume: true,
  })
  assert.equal(resumed.complete, true)
  const store = new FileAlgorithmRunStore(join(root, 'run'))
  assert.equal((await store.readCheckpoint('step-000001.json')).step, 1)
  assert.equal((await store.readCheckpoint('step-000001-01.json')).step, 1)
})

test('通用 Algorithm Runner 拒绝不受限的步数和非法 Checkpoint Codec', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-generic-invalid-'))
  assert.rejects(
    () => runGenericEvolution({ driver: driver(join(root, 'run')), maxSteps: 100_001 }),
    /maxSteps/u,
  )
  const invalid = { ...driver(join(root, 'bad')), checkpointCodec: { version: 'v1' } }
  await assert.rejects(() => runGenericEvolution({ driver: invalid }), /CheckpointCodec/u)
})

test('FileAlgorithmRunStore 并发追加事件仍保持唯一序号并限制事件大小', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-generic-events-'))
  const store = new FileAlgorithmRunStore(join(root, 'run'))
  await store.initialize({ state: { status: 'active' } })
  const records = await Promise.all(Array.from({ length: 20 }, (_, index) =>
    store.appendEvent({ type: 'step', index })))
  assert.deepEqual(records.map((record) => record.sequence).sort((a, b) => a - b),
    Array.from({ length: 20 }, (_, index) => index + 1))
  await assert.rejects(() => store.appendEvent({ value: 'x'.repeat(10_000) }), /字节上限/u)
})
