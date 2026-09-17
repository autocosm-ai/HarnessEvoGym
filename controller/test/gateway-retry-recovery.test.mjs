import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { EXECUTION_IDENTITY_VERSION } from '../src/execution-identity.mjs'
import { assertGatewayRetryRecovery, recordGatewayRetryRecovery, retryGatewayConfig } from '../src/gateway-retry-recovery.mjs'
import { startFixtureGateway } from './fixtures/solver-failure-runtime.mjs'

function identity(files, nodeVersion = process.version) {
  const spec = { files, dependencies: {}, nodeVersion }
  return { version: EXECUTION_IDENTITY_VERSION, spec,
    digest: createHash('sha256').update(JSON.stringify(spec)).digest('hex') }
}

test('只接受指定重试补丁，不放行其他执行漂移，原冻结身份不变', () => {
  const before = { path: 'docker/model-gateway/server.mjs', mode: '100644', sha256: 'a'.repeat(64) }
  const after = { ...before, sha256: 'b'.repeat(64) }
  const stored = identity([before]), current = identity([after])
  const frozen = JSON.stringify(stored)
  const patch = { kind: 'GatewayRetryCodePatch', changes: [{ path: before.path, before, after }] }
  assertGatewayRetryRecovery(stored, current, patch, 20)
  assert.equal(JSON.stringify(stored), frozen)
  assert.throws(() => assertGatewayRetryRecovery(stored, identity([{ ...after, sha256: 'c'.repeat(64) }]), patch, 20), /范围之外/u)
  assert.throws(() => assertGatewayRetryRecovery(stored, identity([after], 'different'), patch, 20), /Node/u)
  assert.throws(() => assertGatewayRetryRecovery(stored, current, patch, 21), /0..20/u)
  const config = { image: 'old-image', maximumUpstreamRetries: 5, port: 8080 }
  assert.equal(retryGatewayConfig(config, 20).maximumUpstreamRetries, 20)
  assert.equal(config.maximumUpstreamRetries, 5)
  assert.throws(() => retryGatewayConfig(config, 4), /增加/u)
})

test('恢复记录首次追加、同内容幂等，拒绝替换已有记录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-retry-receipt-'))
  await mkdir(join(root, 'public'))
  const receipt = { kind: 'GatewayRetryRecovery', maximumUpstreamRetries: 20 }
  await recordGatewayRetryRecovery(root, receipt)
  await recordGatewayRetryRecovery(root, receipt)
  await assert.rejects(recordGatewayRetryRecovery(root, { ...receipt, maximumUpstreamRetries: 10 }), /不同/u)
  assert.deepEqual(JSON.parse(await readFile(join(root, 'public/gateway-retry-recovery.json'))), receipt)
})

for (const maximumUpstreamRetries of [10, 20]) {
  test('真实网关：前 ' + maximumUpstreamRetries + ' 次 503 后成功，同一请求重发不能扩大总额度', async (t) => {
    const modes = new Map()
    const gateway = await startFixtureGateway(t, { modes, maximumUpstreamRetries })
    // fixture 每次请求动态选状态；第 N+1 次恢复成功。
    modes.get = () => gateway.observed.length < maximumUpstreamRetries ? 'http503' : 'valid'
    const context = { trialId: 'retry-' + maximumUpstreamRetries, candidateId: 'h0',
      candidateDigest: 'a'.repeat(64), partition: 'feedback', instanceId: 'officeval_001', seed: 1 }
    const access = await gateway.beginTrial(context, {
      model: 'fixture', maxTokens: 128, maxTokensField: 'max_tokens', reasoningEffort: 'high',
    })
    const options = { method: 'POST', headers: {
      authorization: 'Bearer ' + access.secretEnvironment.RSI_PROVIDER_API_KEY,
      'content-type': 'application/json',
    }, body: JSON.stringify({ messages: [{ role: 'user', content: 'CASE=valid fixture' }] }) }
    const response = await fetch(gateway.url + '/chat/completions', options)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /valid final content/u)
    assert.equal(gateway.observed.length, maximumUpstreamRetries + 1)
    const blocked = await fetch(gateway.url + '/chat/completions', options)
    assert.equal(blocked.status, 429)
    assert.match(await blocked.text(), /retry_budget_exhausted/u)
    assert.equal(gateway.observed.length, maximumUpstreamRetries + 1)
    const diagnostic = await gateway.endTrial(context.trialId)
    assert.equal(diagnostic.requests[0].attempts, maximumUpstreamRetries + 1)
  })
}
