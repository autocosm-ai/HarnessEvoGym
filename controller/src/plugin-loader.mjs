import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { parse as parseYAML } from 'yaml'
import { ProtocolError } from './protocol.mjs'
import { validatePluginManifest, isProtocolCompatible } from '../../sdk/index.mjs'

/**
 * Plugin 注册表，按协议类型分类存储
 */
const PLUGIN_REGISTRY = {
  environment: new Map(),
  solver: new Map(),
  updater: new Map(),
  algorithm: new Map(),
  evaluator: new Map(),
  strategy: new Map(),
}

/**
 * 从目录加载 plugin.yaml 并解析
 * @param {string} pluginPath - 插件目录路径
 * @returns {Promise<Object>} Plugin Manifest
 */
export async function loadPluginManifest(pluginPath) {
  const manifestPath = join(pluginPath, 'plugin.yaml')
  try {
    const content = await readFile(manifestPath, 'utf-8')
    const manifest = parseYAML(content)

    if (!validatePluginManifest(manifest)) {
      throw new ProtocolError(`插件清单格式无效：${manifestPath}`)
    }

    // 补充插件根目录路径
    manifest._pluginRoot = resolve(pluginPath)
    return manifest
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new ProtocolError(`插件清单不存在：${manifestPath}`)
    }
    throw error
  }
}

/**
 * 注册插件到 Registry
 * @param {Object} manifest - Plugin Manifest
 * @param {Function} factory - Driver Factory 函数
 */
export function registerPlugin(manifest, factory) {
  const { kind, version, implementation } = manifest.protocol
  const registry = PLUGIN_REGISTRY[kind]

  if (!registry) {
    throw new ProtocolError(`不支持的插件类型：${kind}`)
  }

  // 协议名称：implementation 已包含版本（如 fake-deterministic-v1），不再重复拼接
  const protocolName = implementation ?? `${manifest.identity.name}-${version}`

  if (registry.has(protocolName)) {
    throw new ProtocolError(`插件协议重复注册：${protocolName}`)
  }

  registry.set(protocolName, {
    manifest,
    factory,
  })

  console.log(`[Plugin] 注册 ${kind}: ${protocolName} (${manifest.identity.name}@${manifest.identity.version})`)
}

/**
 * 从插件目录自动加载并注册
 * @param {string} pluginPath - 插件目录路径
 */
export async function autoRegisterPlugin(pluginPath) {
  const manifest = await loadPluginManifest(pluginPath)

  // 加载插件入口文件
  let entrypoint
  if (manifest.runtime.type === 'node') {
    const entrypointPath = resolve(
      manifest._pluginRoot,
      manifest.runtime.node.entrypoint,
    )
    const module = await import(entrypointPath)
    entrypoint = module.default ?? module
  } else {
    throw new ProtocolError(`暂不支持 runtime.type: ${manifest.runtime.type}`)
  }

  if (typeof entrypoint !== 'function') {
    throw new ProtocolError(`插件入口必须导出 factory 函数：${manifest.identity.name}`)
  }

  registerPlugin(manifest, entrypoint)
}

/**
 * 查找已注册的插件
 * @param {string} kind - 插件类型：environment / solver / updater / algorithm / evaluator
 * @param {string} protocol - 协议名称（含版本），如 'fake-deterministic-v1'
 * @returns {Object|null} { manifest, factory }
 */
export function findPlugin(kind, protocol) {
  const registry = PLUGIN_REGISTRY[kind]
  if (!registry) return null
  return registry.get(protocol) ?? null
}

/**
 * 列出已注册的插件
 * @param {string} [kind] - 插件类型（可选，不传则返回所有类型）
 * @returns {Object} 插件清单列表，按类型分组
 */
export function listRegisteredPlugins(kind = null) {
  if (kind) {
    const registry = PLUGIN_REGISTRY[kind]
    if (!registry) return []
    return Array.from(registry.entries()).map(([protocol, { manifest }]) => ({
      protocol,
      ...manifest.identity,
      trust: manifest.trust.mode,
    }))
  }

  const result = {}
  for (const [type, registry] of Object.entries(PLUGIN_REGISTRY)) {
    result[type] = Array.from(registry.entries()).map(([protocol, { manifest }]) => ({
      protocol,
      ...manifest.identity,
      trust: manifest.trust.mode,
    }))
  }
  return result
}

/**
 * 发现并加载目录下的所有插件
 * @param {string} pluginsRoot - 插件根目录（如 ./plugins）
 */
export async function discoverPlugins(pluginsRoot) {
  const { readdir } = await import('node:fs/promises')
  const { stat } = await import('node:fs/promises')

  try {
    const entries = await readdir(pluginsRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const pluginPath = join(pluginsRoot, entry.name)
        const manifestPath = join(pluginPath, 'plugin.yaml')
        try {
          await stat(manifestPath)
          await autoRegisterPlugin(pluginPath)
        } catch (error) {
          if (error.code !== 'ENOENT') {
            console.warn(`[Plugin] 加载失败：${pluginPath}`, error.message)
          }
        }
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`[Plugin] 插件目录不存在：${pluginsRoot}`)
    }
  }
}

/**
 * 创建 Plugin Driver 实例
 * @param {string} kind - 插件类型
 * @param {string} protocol - 协议名称
 * @param {Object} options - Driver 初始化参数
 * @returns {Object} Driver 实例
 */
export function createPluginDriver(kind, protocol, options) {
  const plugin = findPlugin(kind, protocol)
  if (!plugin) {
    throw new ProtocolError(`未注册的插件：${kind}/${protocol}`)
  }

  const { manifest, factory } = plugin

  // 协议版本兼容性检查
  const requiredVersion = protocol.match(/-v(\d+)$/)?.[1] ?? '1'
  if (!isProtocolCompatible(`v${requiredVersion}`, manifest.protocol.version)) {
    throw new ProtocolError(
      `插件协议版本不兼容：要求 v${requiredVersion}，提供 ${manifest.protocol.version}`,
    )
  }

  // 调用 factory 创建 Driver 实例
  const driver = factory(options)

  // 验证 Driver 接口（根据 kind 检查必需方法）
  const requiredMethods = {
    environment: ['preflight', 'runCandidatePartition', 'getCapabilities'],
    solver: ['ensureRuntime', 'run', 'usage'],
    updater: ['ensureRuntime', 'stageContext', 'run', 'usage'],
    algorithm: ['initialize', 'run', 'resume', 'report', 'freezeBaseline'],
    evaluator: ['validateManifest', 'evaluate', 'formatReport'],
  }

  const methods = requiredMethods[kind] ?? []
  for (const method of methods) {
    if (typeof driver[method] !== 'function') {
      throw new ProtocolError(`插件 ${manifest.identity.name} 缺少方法：${method}()`)
    }
  }

  return driver
}
