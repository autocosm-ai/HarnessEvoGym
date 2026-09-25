import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createEvolutionAlgorithmDriver,
  registerEvolutionAlgorithm,
  registeredEvolutionAlgorithms,
} from '../src/evolution-algorithm.mjs'
import { ProtocolError } from '../src/protocol.mjs'
import { PopulationStore } from '../src/population-store.mjs'
import { normalizeEvolutionAlgorithm } from '../src/evolution-algorithm-reference.mjs'

test('Evolution Algorithm Registry 提供 Population 默认实现和可注册扩展', async () => {
  assert.ok(registeredEvolutionAlgorithms().includes('population-v1'))

  const calls = []
  registerEvolutionAlgorithm('fixture-algorithm', ({ algorithm, marker }) => {
    calls.push({ algorithm, marker })
    return {
      store: new PopulationStore('/tmp/algorithm-fixture', 'fixture'),
      async initialize() { return { status: 'initialized' } },
      async run() { return { status: 'closed' } },
      async resume() { return { status: 'resumed' } },
      async report() { return { status: 'reported' } },
      async freezeBaseline() { return { state: {} } },
    }
  })

  const driver = createEvolutionAlgorithmDriver({
    algorithm: { id: 'fixture-algorithm', configuration: { budget: 4 } },
    options: { marker: 'fixture', campaignsRoot: '/tmp/algorithm-fixture', campaignId: 'fixture' },
  })
  assert.deepEqual(await driver.initialize(), { status: 'initialized' })
  assert.deepEqual(await driver.run(), { status: 'closed' })
  assert.deepEqual(calls, [{
    algorithm: { id: 'fixture-algorithm', configuration: { budget: 4 } },
    marker: 'fixture',
  }])
})

test('Algorithm 配置不能被静默改写，深层配置不可变', () => {
  const cycle = {}; cycle.self = cycle
  for (const configuration of [{ a: NaN }, { a: undefined }, { a: () => {} }, { a: new Date() }, cycle]) {
    assert.throws(() => normalizeEvolutionAlgorithm({ id: 'fixture', configuration }), ProtocolError)
  }
  const source = { nested: { values: [1, 2] } }
  const normalized = normalizeEvolutionAlgorithm({ id: 'fixture', configuration: source })
  source.nested.values.push(3)
  assert.deepEqual(normalized.configuration.nested.values, [1, 2])
  assert.throws(() => normalized.configuration.nested.values.push(4), TypeError)
  assert.throws(() => createEvolutionAlgorithmDriver({
    algorithm: { id: 'population-v1', configuration: { ignored: true } }, options: {},
  }), /不接受 configuration/u)
})

test('Evolution Algorithm Registry 拒绝未知算法、非法配置和不完整 Driver', () => {
  assert.throws(
    () => createEvolutionAlgorithmDriver({ algorithm: 'missing-algorithm', options: {} }),
    (error) => error instanceof ProtocolError && /未注册/u.test(error.message),
  )
  assert.throws(
    () => createEvolutionAlgorithmDriver({
      algorithm: { id: 'fixture-algorithm', configuration: [] },
      options: {},
    }),
    (error) => error instanceof ProtocolError && /必须是 JSON 对象/u.test(error.message),
  )

  registerEvolutionAlgorithm('fixture-incomplete-algorithm', () => ({ initialize() {} }))
  assert.throws(
    () => createEvolutionAlgorithmDriver({ algorithm: 'fixture-incomplete-algorithm', options: {} }),
    (error) => error instanceof ProtocolError && /缺少 run\(\)/u.test(error.message),
  )
})
