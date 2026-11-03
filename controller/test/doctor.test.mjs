import assert from 'node:assert/strict'
import test from 'node:test'
import { runDoctor } from '../src/doctor.mjs'
import { REPOSITORY_ROOT } from '../src/config.mjs'

const input = { repositoryRoot: REPOSITORY_ROOT, experimentPath: 'experiments/cowork-msa-acceptance.json',
  environment: { RSI_PROVIDER_API_KEY: 'fixture-secret-never-in-report', RSI_PROVIDER_BASE_URL: 'https://fixture.invalid/v1' } }
const deps = {
  command: async () => ({ stdout: '/fixture/docker-root\n' }),
  disk: async () => ({ bavail: 10, bsize: 1024 ** 3 }),
  preflight: async () => ({}),
  dockerFactory: () => ({ async info() {}, async imageExists() { return true } }),
}

test('doctor 默认不发模型请求，报告列出可执行的检查结果且不泄露凭据', async () => {
  let requests = 0
  const report = await runDoctor(input, { ...deps, request: () => { requests++; throw new Error() } })
  assert.equal(requests, 0)
  assert.equal(report.ready, true)
  assert.equal(report.modelProbePerformed, false)
  assert.ok(report.checks.some((x) => x.id === 'data-and-source' && x.status === 'pass'))
  assert.doesNotMatch(JSON.stringify(report), /fixture-secret/u)
})

test('磁盘不足、数据缺失和 Docker 故障聚合返回，不在首个错误处退出', async () => {
  const report = await runDoctor(input, { ...deps,
    disk: async () => ({ bavail: 0, bsize: 4096 }),
    preflight: async () => { throw new Error('dataset missing') },
    dockerFactory: () => ({ async info() { throw new Error('no permission') }, async imageExists() { return false } }),
  })
  assert.equal(report.ready, false)
  assert.deepEqual(report.checks.filter((x) => x.status === 'fail').map((x) => x.id), ['disk', 'docker', 'data-and-source'])
  assert.ok(report.checks.filter((x) => x.status === 'fail').every((x) => x.remedy))
})

test('显式模型探测覆盖 Solver/Updater；认证错误不回显服务端正文', async () => {
  const requests = []
  const report = await runDoctor({ ...input, probeModels: true }, { ...deps, request: async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) })
    if (requests.length === 1) return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }))
    return new Response('fixture-secret-never-in-report', { status: 401 })
  } })
  assert.equal(requests.length, 2)
  assert.ok(requests.every((x) => x.body.model === 'gpt-6.1-sol'))
  assert.equal(report.ready, false)
  assert.equal(report.checks.find((x) => x.id === 'updater-model').status, 'fail')
  assert.doesNotMatch(JSON.stringify(report), /fixture-secret/u)
})
