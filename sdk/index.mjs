/**
 * Harness EvoGym SDK
 *
 * 外部插件开发包，定义 Target、Environment、Algorithm、Strategy、Updater、Evaluator 的标准接口。
 */

export { EnvironmentDriver } from './interfaces/environment.mjs'
export { SolverDriver } from './interfaces/solver.mjs'
export { UpdaterDriver } from './interfaces/updater.mjs'
export { EvolutionAlgorithmDriver } from './interfaces/algorithm.mjs'
export { EvolutionAlgorithmDriverV2 } from './interfaces/algorithm-v2.mjs'
export { Evaluator } from './interfaces/evaluator.mjs'

/**
 * Plugin Manifest 验证（供 Controller 使用）
 * @param {Object} manifest - 从 plugin.yaml 解析的对象
 * @returns {boolean} 是否合法
 */
export function validatePluginManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return false
  const plain = (value) => value && typeof value === 'object' && !Array.isArray(value)
  const identity = manifest.identity
  const protocol = manifest.protocol
  const runtime = manifest.runtime
  const trust = manifest.trust
  if (!plain(identity) || !plain(protocol) || !plain(runtime) || !plain(trust)) return false
  if (typeof identity.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(identity.name)) return false
  if (typeof identity.version !== 'string'
      || !/^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/u.test(identity.version)) return false
  const kinds = new Set(['environment', 'solver', 'updater', 'algorithm', 'evaluator', 'strategy'])
  if (typeof protocol.kind !== 'string' || !kinds.has(protocol.kind)) return false
  if (typeof protocol.version !== 'string' || !/^v\d+$/u.test(protocol.version)) return false
  if (protocol.implementation !== undefined
      && (typeof protocol.implementation !== 'string'
        || !/^[a-z0-9]+(?:-[a-z0-9]+)*-v\d+$/u.test(protocol.implementation))) return false
  if (!new Set(['node', 'docker', 'python']).has(runtime.type)) return false
  if (runtime.type === 'node') {
    if (!plain(runtime.node) || typeof runtime.node.entrypoint !== 'string'
        || runtime.node.entrypoint.length === 0 || runtime.node.entrypoint.startsWith('/')
        || runtime.node.entrypoint.split('/').some((part) => part === '..' || part === '')) return false
  }
  if (runtime.type === 'python') {
    if (!plain(runtime.python) || typeof runtime.python.entrypoint !== 'string'
        || runtime.python.entrypoint.length === 0 || runtime.python.entrypoint.startsWith('/')
        || runtime.python.entrypoint.split('/').some((part) => part === '..' || part === '')) return false
  }
  if (runtime.type === 'docker') {
    if (!plain(runtime.docker) || typeof runtime.docker.image !== 'string'
        || runtime.docker.image.trim().length === 0) return false
    if (runtime.docker.digest !== undefined
        && (typeof runtime.docker.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(runtime.docker.digest))) return false
  }
  if (!new Set(['trusted', 'sandbox']).has(trust.mode)) return false
  if (trust.permissions !== undefined && (!Array.isArray(trust.permissions)
      || trust.permissions.some((value) => !new Set(['filesystem-read', 'filesystem-write', 'network', 'docker']).has(value)))) return false
  if (manifest.capabilities !== undefined && !plain(manifest.capabilities)) return false
  return true
}

/**
 * 协议版本兼容性检查
 * @param {string} required - Controller 要求的协议版本，如 'v1'
 * @param {string} provided - Plugin 声明的协议版本，如 'v1'
 * @returns {boolean} 是否兼容
 */
export function isProtocolCompatible(required, provided) {
  // 简单实现：仅检查主版本号匹配
  // 未来可扩展为 SemVer 语义化版本比较
  const reqMajor = required.match(/^v(\d+)$/)?.[1]
  const provMajor = provided.match(/^v(\d+)$/)?.[1]
  return reqMajor === provMajor
}
