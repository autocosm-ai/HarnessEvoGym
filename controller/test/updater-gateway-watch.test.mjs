import assert from 'node:assert/strict'
import test from 'node:test'
import { startFixtureGateway } from './fixtures/solver-failure-runtime.mjs'

test('真实网关只监测 Updater 的重复输出，进度接口仅 Controller 可读，并支持下一次尝试重置', async (t) => {
  const gateway = await startFixtureGateway(t)
  await gateway.controlCall('/rsi/configure-role', {
    role: 'updater', model: 'fixture', maxTokens: 8192, maxTokensField: 'max_tokens',
  })
  const sample = () => gateway.controlCall('/rsi/updater-progress')
  const call = async (token) => {
    const response = await fetch(`${gateway.url}/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'CASE=repeated' }] }),
    })
    assert.equal(response.status, 200)
    await response.text()
  }
  assert.equal((await fetch(`${gateway.url}/rsi/updater-progress`, {
    headers: { authorization: `Bearer ${'s'.repeat(64)}` },
  })).status, 401)
  await gateway.access('solver', { model: 'fixture', maxTokens: 8192, maxTokensField: 'max_tokens' })
  await call('s'.repeat(64))
  assert.equal((await sample()).failureCode, null)
  await call('u'.repeat(64))
  const report = await sample()
  assert.equal(report.failureCode, 'updater-repetitive-output')
  assert.doesNotMatch(JSON.stringify(report), /Before editing/u)
  assert.equal((await gateway.controlCall('/rsi/updater-progress', {})).failureCode, null)
})
