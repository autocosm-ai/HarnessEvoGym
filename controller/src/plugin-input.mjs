import { dirname, relative, resolve } from 'node:path'
import { snapshotTree, treeDigest } from './candidate.mjs'
import { loadPluginManifest } from './plugin-loader.mjs'
import { ProtocolError, readJsonFile } from './protocol.mjs'

/** 显式 CLI 参数才允许加载外部受信插件；HTTP API 不使用这个入口。 */
export async function inspectPluginInputs({ repositoryRoot, plugin, plugins, runRoot }) {
  if (Boolean(plugin) === Boolean(plugins)) throw new ProtocolError('必须且只能提供 --plugin 或 --plugins')
  let roots
  if (plugin) roots = [resolve(repositoryRoot, plugin)]
  else {
    const file = resolve(repositoryRoot, plugins)
    const set = await readJsonFile(file)
    if (set?.kind !== 'PluginSet' || !Array.isArray(set.plugins) || !set.plugins.length
        || set.plugins.length > 32 || Object.keys(set).some((key) => !['kind', 'plugins'].includes(key))
        || set.plugins.some((path) => typeof path !== 'string' || !path.trim())) {
      throw new ProtocolError('PluginSet 必须声明 1..32 个插件目录')
    }
    roots = set.plugins.map((path) => resolve(dirname(file), path))
  }
  if (new Set(roots).size !== roots.length) throw new ProtocolError('PluginSet 不能重复加载插件目录')
  const identity = []
  for (const root of roots) {
    const rel = relative(root, runRoot)
    if (rel === '' || (!rel.startsWith('../') && rel !== '..')) {
      throw new ProtocolError('Algorithm Run 必须位于插件源码目录之外')
    }
    const manifest = await loadPluginManifest(root)
    if (manifest.trust.mode !== 'trusted') throw new ProtocolError('CLI 只接受显式选择的 trusted 插件')
    // 包含依赖文件；不跳过 node_modules，避免同版本依赖被修改后继续复用旧结果。
    const snapshot = await snapshotTree(root, {
      maximumFileBytes: 16 * 1024 * 1024, maximumTreeEntries: 20_000,
      exclude: (path) => path === '.git' || path.startsWith('.git/'),
    })
    if ([...snapshot.values()].reduce((sum, item) => sum + item.bytes, 0) > 128 * 1024 * 1024) {
      throw new ProtocolError('插件及依赖源码总量超过 128 MiB')
    }
    identity.push({ ...manifest.identity, protocol: manifest.protocol, sourceDigest: treeDigest(snapshot) })
  }
  return { roots, identity }
}
