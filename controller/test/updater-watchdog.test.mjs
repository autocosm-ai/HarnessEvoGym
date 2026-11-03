import assert from 'node:assert/strict'
import test from 'node:test'
import { StreamWatch } from '../../docker/model-gateway/stream-watch.mjs'
import { superviseUpdater, updaterSupervision } from '../src/updater-watchdog.mjs'
import { runProcess } from '../src/process.mjs'
import { DockerClient } from '../src/docker.mjs'

const repeated = 'Before editing, inspect the existing labels and preserve the document content. '.repeat(90)
const sse = (value) => Buffer.from(`data: ${JSON.stringify(value)}\n\n`)

test('三种模型协议的重复工具参数都能识别，分块输入不影响判断，报告不含正文', () => {
  for (const event of [
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: repeated } }] } }] },
    { type: 'response.function_call_arguments.delta', item_id: 'call1', delta: repeated },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: repeated } },
  ]) {
    const watch = new StreamWatch()
    watch.start('one')
    const bytes = sse(event)
    for (let i = 0; i < bytes.length; i += 13) watch.chunk('one', bytes.subarray(i, i + 13))
    assert.equal(watch.snapshot().failureCode, 'updater-repetitive-output')
    assert.doesNotMatch(JSON.stringify(watch.snapshot()), /Before editing/u)
  }
})

test('正常正文、少量重复和不同请求不误判；keepalive 不掩盖没有进展', () => {
  let now = 100
  const watch = new StreamWatch({ now: () => now })
  for (let i = 0; i < 10; i++) {
    watch.start(`request-${i}`)
    watch.chunk(`request-${i}`, sse({ choices: [{ delta: { content: repeated.slice(0, 1500) } }] }))
    watch.end(`request-${i}`)
  }
  assert.equal(watch.snapshot().failureCode, null)
  watch.start('keepalive')
  now = 200
  watch.chunk('keepalive', Buffer.from(': ping\n\n'))
  assert.equal(watch.snapshot().lastProgressAt, 100)
  for (const value of [null, { choices: {} }, { choices: [null] }, { choices: [{ delta: { tool_calls: [null] } }] }]) {
    assert.doesNotThrow(() => watch.chunk('keepalive', sse(value)))
  }
  watch.reset()
  assert.equal(watch.snapshot().activeStreams, 0)
})

test('看门狗能结束真实无输出子进程，并返回明确的空闲超时代码', async () => {
  await assert.rejects(superviseUpdater({ idleTimeoutMs: 80, pollMs: 10,
    execute: ({ signal }) => runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
      { signal, timeoutMs: 10_000 }),
  }), (error) => error.code === 'updater-idle-timeout' && error.retryable)
})

test('重复输出触发中止，正常完成不被中止；监测不可用也明确暂停', async () => {
  await assert.rejects(superviseUpdater({ pollMs: 5,
    sample: () => ({ lastProgressAt: Date.now(), failureCode: 'updater-repetitive-output' }),
    execute: async ({ signal }) => {
      assert.equal(signal.aborted, false)
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
    },
  }), (error) => error.code === 'updater-repetitive-output')
  assert.equal(await superviseUpdater({ execute: async () => 'finished', pollMs: 5 }), 'finished')
  let finished = false
  await assert.rejects(superviseUpdater({ pollMs: 1000,
    sample: () => ({ lastProgressAt: Date.now(), failureCode: finished ? 'updater-repetitive-output' : null }),
    execute: async () => { finished = true; return 'fast response' },
  }), (error) => error.code === 'updater-repetitive-output')
  await assert.rejects(superviseUpdater({ pollMs: 5, sample: () => { throw new Error('network') },
    execute: async ({ signal }) => new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })),
  }), (error) => error.code === 'updater-monitor-unavailable')
  for (const value of [null, { maximumRetries: 20 }, { idleTimeoutSeconds: 0 }, { ignored: true }]) {
    assert.throws(() => updaterSupervision(value))
  }
})

test('真实 Docker Updater 被看门狗中止后不遗留容器', {
  skip: process.env.RSI_RUN_DOCKER_E2E !== '1', timeout: 30_000,
}, async () => {
  const docker = new DockerClient({ resources: { cpus: 0.25, memory: '128m', pids: 64, timeoutSeconds: 15 } })
  const name = `p0-watchdog-${process.pid}`
  try {
    await assert.rejects(superviseUpdater({ idleTimeoutMs: 1000, pollMs: 100,
      sample: async () => {
        const status = await docker.containerHealth(name).catch(() => '')
        return { lastProgressAt: Date.now() - (status === 'running' ? 2000 : 0), failureCode: null }
      },
      execute: ({ signal }) => docker.run({ name, image: 'node:24-bookworm-slim', network: 'none', signal,
        command: ['node', '-e', 'setInterval(() => {}, 1000)'] }),
    }), (error) => error.code === 'updater-idle-timeout')
    await assert.rejects(docker.containerHealth(name))
  } finally { await docker.removeContainer(name) }
})
