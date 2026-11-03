import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { autoRegisterPlugin, loadPluginManifest } from '../src/plugin-loader.mjs'
import { isProtocolCompatible } from '../../sdk/index.mjs'

function manifest(name, { mode = 'trusted', version = 'v1' } = {}) {
  return { identity: { name, version: '0.1.0' },
    protocol: { kind: 'environment', version, implementation: `${name}-v1` },
    runtime: { type: 'node', node: { entrypoint: 'index.mjs' } }, trust: { mode } }
}

test('插件在执行入口之前拒绝 sandbox 和协议版本错配', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-trust-'))
  try {
    const marker = join(root, 'executed.txt')
    await writeFile(join(root, 'index.mjs'), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed'); export default () => ({});`)
    for (const options of [{ mode: 'sandbox' }, { version: 'v9' }]) {
      await writeFile(join(root, 'plugin.yaml'), JSON.stringify(manifest('unsafe-probe', options)))
      await assert.rejects(() => autoRegisterPlugin(root), /trusted|版本|协议/u)
      await assert.rejects(() => readFile(marker), { code: 'ENOENT' })
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('插件清单不能通过符号链接读取目录外的配置', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-manifest-'))
  try {
    await writeFile(join(root, 'outside.json'), JSON.stringify(manifest('linked-manifest')))
    await symlink('outside.json', join(root, 'plugin.yaml'))
    await assert.rejects(() => loadPluginManifest(root), /普通文件|符号链接/u)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('包含 URL 保留字符的本地插件路径能正常加载', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-url-#-'))
  try {
    const config = manifest('url-path-probe')
    await writeFile(join(root, 'plugin.yaml'), JSON.stringify(config))
    await writeFile(join(root, 'index.mjs'), 'export default () => ({ preflight() {}, runCandidatePartition() {}, describeCapabilities() {} });')
    await autoRegisterPlugin(root)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('非法的协议版本不能因为双方解析失败而被认为兼容', () => {
  assert.equal(isProtocolCompatible('broken', 'invalid'), false)
  assert.equal(isProtocolCompatible(null, null), false)
  assert.equal(isProtocolCompatible('v2', 'v2'), true)
  assert.equal(isProtocolCompatible('v1', 'v2'), false)
})
