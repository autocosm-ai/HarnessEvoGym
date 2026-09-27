import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validatePluginManifest } from '../../sdk/index.mjs'

const manifest = {
  identity: { name: 'example-plugin', version: '1.2.3' },
  protocol: { kind: 'environment', version: 'v1', implementation: 'example-plugin-v1' },
  runtime: { type: 'node', node: { entrypoint: './index.mjs' } },
  trust: { mode: 'trusted' },
}

test('SDK 严格校验插件清单的身份、运行时和信任字段', () => {
  assert.equal(validatePluginManifest(manifest), true)
  assert.equal(validatePluginManifest({ ...manifest, identity: { ...manifest.identity, name: '../escape' } }), false)
  assert.equal(validatePluginManifest({ ...manifest, protocol: { ...manifest.protocol, version: 'v1.2' } }), false)
  assert.equal(validatePluginManifest({ ...manifest, runtime: { type: 'node', node: { entrypoint: '../index.mjs' } } }), false)
  assert.equal(validatePluginManifest({ ...manifest, trust: { mode: 'root' } }), false)
  assert.equal(validatePluginManifest({ ...manifest, runtime: { type: 'docker', docker: { image: 'runner:latest' } } }), true)
  assert.equal(validatePluginManifest({ ...manifest, runtime: { type: 'docker', docker: { image: 'runner', digest: 'sha256:bad' } } }), false)
})
