/**
 * Harness EvoGym SDK
 *
 * 外部插件开发包，定义 Target、Environment、Algorithm、Strategy、Updater、Evaluator 的标准接口。
 */

export { EnvironmentDriver } from './interfaces/environment.mjs'
export { SolverDriver } from './interfaces/solver.mjs'
export { UpdaterDriver } from './interfaces/updater.mjs'
export { EvolutionAlgorithmDriver } from './interfaces/algorithm.mjs'
export { Evaluator } from './interfaces/evaluator.mjs'

/**
 * Plugin Manifest 验证（供 Controller 使用）
 * @param {Object} manifest - 从 plugin.yaml 解析的对象
 * @returns {boolean} 是否合法
 */
export function validatePluginManifest(manifest) {
  // TODO: 使用 plugin-v1.schema.json 进行 JSON Schema 验证
  if (!manifest || typeof manifest !== 'object') return false
  if (!manifest.identity?.name || !manifest.identity?.version) return false
  if (!manifest.protocol?.kind || !manifest.protocol?.version) return false
  if (!manifest.runtime?.type) return false
  if (!manifest.trust?.mode) return false
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
