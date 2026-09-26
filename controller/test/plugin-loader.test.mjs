import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  loadPluginManifest,
  autoRegisterPlugin,
  findPlugin,
  listRegisteredPlugins,
  createPluginDriver,
} from '../src/plugin-loader.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FAKE_ENV_PATH = resolve(__dirname, '../../sdk/examples/fake-environment')

describe('Plugin Loader', () => {
  it('加载 Fake Environment 插件清单', async () => {
    const manifest = await loadPluginManifest(FAKE_ENV_PATH)

    assert.equal(manifest.identity.name, 'fake-environment')
    assert.equal(manifest.protocol.kind, 'environment')
    assert.equal(manifest.protocol.version, 'v1')
    assert.equal(manifest.protocol.implementation, 'fake-deterministic-v1')
    assert.equal(manifest.runtime.type, 'node')
    assert.equal(manifest.trust.mode, 'trusted')
    assert.ok(manifest._pluginRoot.endsWith('fake-environment'))
  })

  it('自动注册 Fake Environment 插件', async () => {
    await autoRegisterPlugin(FAKE_ENV_PATH)

    const plugin = findPlugin('environment', 'fake-deterministic-v1')
    assert.ok(plugin, '插件应该已注册')
    assert.equal(plugin.manifest.identity.name, 'fake-environment')
    assert.equal(typeof plugin.factory, 'function')
  })

  it('列出已注册的 Environment 插件', async () => {
    await autoRegisterPlugin(FAKE_ENV_PATH)

    const plugins = listRegisteredPlugins('environment')
    const fakeEnv = plugins.find((p) => p.name === 'fake-environment')

    assert.ok(fakeEnv, 'Fake Environment 应该在列表中')
    assert.equal(fakeEnv.protocol, 'fake-deterministic-v1')
    assert.equal(fakeEnv.version, '0.1.0')
    assert.equal(fakeEnv.trust, 'trusted')
  })

  it('创建 Fake Environment Driver 实例', async () => {
    await autoRegisterPlugin(FAKE_ENV_PATH)

    const driver = createPluginDriver('environment', 'fake-deterministic-v1', {
      config: {
        taskCount: 5,
        difficulty: 'medium',
        seed: 42,
      },
    })

    assert.ok(driver, 'Driver 应该成功创建')
    assert.equal(typeof driver.preflight, 'function')
    assert.equal(typeof driver.runCandidatePartition, 'function')
    assert.equal(typeof driver.getCapabilities, 'function')

    const capabilities = driver.getCapabilities()
    assert.deepEqual(capabilities.partitions, ['training', 'validation', 'hidden'])
    assert.deepEqual(capabilities.metrics, ['accuracy', 'latency'])
  })

  it('Fake Environment 生成确定性任务', async () => {
    await autoRegisterPlugin(FAKE_ENV_PATH)

    const driver = createPluginDriver('environment', 'fake-deterministic-v1', {
      config: { taskCount: 3, difficulty: 'easy', seed: 12345 },
    })

    const tasks = await driver.listTasks('training')
    assert.equal(tasks.length, 3)
    assert.ok(tasks[0].id.startsWith('training-task-'))
    assert.ok(tasks[0].input.a >= 0 && tasks[0].input.a < 100)
    assert.ok(tasks[0].input.b >= 0 && tasks[0].input.b < 100)
    assert.equal(tasks[0].input.operation, 'add')
    assert.equal(tasks[0].answer, tasks[0].input.a + tasks[0].input.b)

    // 相同 seed 应生成相同任务
    const driver2 = createPluginDriver('environment', 'fake-deterministic-v1', {
      config: { taskCount: 3, difficulty: 'easy', seed: 12345 },
    })
    const tasks2 = await driver2.listTasks('training')
    assert.deepEqual(tasks, tasks2)
  })

  it('Fake Environment 难度级别影响任务类型', async () => {
    await autoRegisterPlugin(FAKE_ENV_PATH)

    const easyDriver = createPluginDriver('environment', 'fake-deterministic-v1', {
      config: { taskCount: 5, difficulty: 'easy', seed: 99 },
    })
    const easyTasks = await easyDriver.listTasks('training')
    assert.ok(easyTasks.every((t) => t.input.operation === 'add'))

    const mediumDriver = createPluginDriver('environment', 'fake-deterministic-v1', {
      config: { taskCount: 5, difficulty: 'medium', seed: 99 },
    })
    const mediumTasks = await mediumDriver.listTasks('training')
    assert.ok(mediumTasks.every((t) => t.input.operation === 'multiply'))

    const hardDriver = createPluginDriver('environment', 'fake-deterministic-v1', {
      config: { taskCount: 5, difficulty: 'hard', seed: 99 },
    })
    const hardTasks = await hardDriver.listTasks('training')
    assert.ok(hardTasks.every((t) => t.input.operation === 'square-sum'))
  })
})
