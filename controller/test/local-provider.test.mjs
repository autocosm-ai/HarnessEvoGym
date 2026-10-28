import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { loadLocalProviderEnvironment } from '../src/local-provider.mjs'
import { loadExperimentBundle } from '../src/adapters.mjs'
import { REPOSITORY_ROOT } from '../src/config.mjs'

async function fixture(t, toml = '[model_providers.zcloud]\nbase_url="https://provider.example/v1"\nenv_key="TEST_PROVIDER_KEY"\n') {
  const root = await mkdtemp(join(tmpdir(), 'gym-local-provider-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '.local'))
  await writeFile(join(root, '.local/provider.json'), JSON.stringify({ source: 'codex', provider: 'zcloud' }))
  await writeFile(join(root, 'config.toml'), toml)
  return { repositoryRoot: root, environment: { CODEX_HOME: root, TEST_PROVIDER_KEY: 'fixture-key-only' } }
}

test('没有本地配置时不读取个人 Codex 凭据', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gym-no-provider-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const environment = {}
  assert.equal(await loadLocalProviderEnvironment({ repositoryRoot: root, environment }), false)
  assert.deepEqual(environment, {})
})

test('从指定 Codex Provider 注入整对凭据；不改变本机默认模型或落盘 Key', async (t) => {
  const input = await fixture(t)
  assert.equal(await loadLocalProviderEnvironment(input), true)
  assert.equal(input.environment.RSI_PROVIDER_BASE_URL, 'https://provider.example/v1')
  assert.equal(input.environment.RSI_PROVIDER_API_KEY, 'fixture-key-only')
  assert.deepEqual((await readdir(join(input.repositoryRoot, '.local'))), ['provider.json'])
  assert.equal((await readFile(join(input.repositoryRoot, '.local/provider.json'), 'utf8')).includes('fixture-key-only'), false)
})

test('校验配置只读取地址，不执行凭据命令', async (t) => {
  const input = await fixture(t, '[model_providers.zcloud]\nbase_url="https://provider.example/v1"\n[model_providers.zcloud.auth]\ncommand="credential-helper"\n')
  await loadLocalProviderEnvironment({ ...input, includeSecrets: false, runCommand: () => assert.fail('不应读取凭据') })
  assert.equal(input.environment.RSI_PROVIDER_BASE_URL, 'https://provider.example/v1')
  assert.equal(input.environment.RSI_PROVIDER_API_KEY, undefined)
})

test('显式凭据整对优先，残缺配置不能混用个人 Key', async (t) => {
  const input = await fixture(t)
  Object.assign(input.environment, { RSI_PROVIDER_BASE_URL: 'https://other.example/v1', RSI_PROVIDER_API_KEY: 'other-fixture-key' })
  assert.equal(await loadLocalProviderEnvironment(input), false)
  assert.equal(input.environment.RSI_PROVIDER_BASE_URL, 'https://other.example/v1')
  delete input.environment.RSI_PROVIDER_API_KEY
  await assert.rejects(loadLocalProviderEnvironment(input), /同时设置/u)
})

test('凭据命令有时限且失败不会泄露 stdout 或 stderr', async (t) => {
  const input = await fixture(t, '[model_providers.zcloud]\nbase_url="https://provider.example/v1"\n[model_providers.zcloud.auth]\ncommand="credential-helper"\ntimeout_ms=2000\n')
  await loadLocalProviderEnvironment({ ...input, runCommand: async (command, args, options) => {
    assert.equal(command, '/bin/sh')
    assert.deepEqual(args, ['-c', 'credential-helper'])
    assert.equal(options.timeout, 2000)
    return { stdout: 'fixture-command-key\n' }
  } })
  assert.equal(input.environment.RSI_PROVIDER_API_KEY, 'fixture-command-key')
  delete input.environment.RSI_PROVIDER_API_KEY
  delete input.environment.RSI_PROVIDER_BASE_URL
  await assert.rejects(loadLocalProviderEnvironment({ ...input, runCommand: async () => {
    throw new Error('fixture-command-key')
  } }), (error) => error.message.includes('凭据命令失败') && !String(error).includes('fixture-command-key'))
  assert.equal(input.environment.RSI_PROVIDER_BASE_URL, undefined)
})

test('拒绝错误本地配置及带认证信息的 URL', async (t) => {
  const input = await fixture(t, '[model_providers.zcloud]\nbase_url="https://user:password@provider.example/v1"\n')
  await assert.rejects(loadLocalProviderEnvironment(input), /有效 base_url/u)
  await writeFile(join(input.repositoryRoot, '.local/provider.json'), 'null')
  await assert.rejects(loadLocalProviderEnvironment(input), /本地 Provider 配置/u)
})

test('所有入门实验的 Solver 和 Updater 均固定 GPT-6.1 Sol / medium', async () => {
  const files = (await readdir(join(REPOSITORY_ROOT, 'experiments'))).filter((name) => name.includes('smoke') && name.endsWith('.json'))
  assert.ok(files.length >= 14)
  for (const name of files) {
    const bundle = await loadExperimentBundle(join(REPOSITORY_ROOT, 'experiments', name), REPOSITORY_ROOT)
    for (const role of ['solver', 'updater']) {
      assert.equal(bundle.experiment.models[role].model, 'gpt-6.1-sol', `${name}: ${role}`)
      assert.equal(bundle.experiment.models[role].reasoningEffort, 'medium', `${name}: ${role}`)
    }
  }
})
