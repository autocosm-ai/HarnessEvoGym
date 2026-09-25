import { resolve } from 'node:path'
import { ProtocolError } from './protocol.mjs'
import { PopulationOrchestrator } from './population-orchestrator.mjs'
import { PopulationStore } from './population-store.mjs'
import { EVOLUTION_ALGORITHM_ID, normalizeEvolutionAlgorithm } from './evolution-algorithm-reference.mjs'

export { normalizeEvolutionAlgorithm } from './evolution-algorithm-reference.mjs'

const ALGORITHM_FACTORIES = new Map()

// 注册的是可信 Controller 代码，当前只支持兼容 Population 状态格式的算法。
export function registerEvolutionAlgorithm(id, factory) {
  if (typeof id !== 'string' || !EVOLUTION_ALGORITHM_ID.test(id)) {
    throw new ProtocolError('Evolution Algorithm ID 必须是 kebab-case')
  }
  if (typeof factory !== 'function') throw new ProtocolError('Evolution Algorithm Factory 必须是函数')
  if (ALGORITHM_FACTORIES.has(id)) throw new ProtocolError(`Evolution Algorithm 重复注册：${id}`)
  ALGORITHM_FACTORIES.set(id, factory)
}

export function registeredEvolutionAlgorithms() {
  return Object.freeze([...ALGORITHM_FACTORIES.keys()].sort())
}

export function assertEvolutionAlgorithmAvailable(algorithm) {
  const reference = normalizeEvolutionAlgorithm(algorithm)
    ?? normalizeEvolutionAlgorithm('population-v1')
  if (!ALGORITHM_FACTORIES.has(reference.id)) {
    throw new ProtocolError(`未注册 Evolution Algorithm：${reference.id}`)
  }
  if (reference.id === 'population-v1' && Object.keys(reference.configuration).length) {
    throw new ProtocolError('population-v1 不接受 configuration；请使用 Recipe.population 配置')
  }
  return reference
}

export function createEvolutionAlgorithmDriver({ algorithm = null, options }) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new ProtocolError('Evolution Algorithm options 必须是对象')
  }
  const reference = assertEvolutionAlgorithmAvailable(algorithm)
  const driver = ALGORITHM_FACTORIES.get(reference.id)({ ...options, algorithm: reference })
  for (const method of ['initialize', 'run', 'resume', 'report', 'freezeBaseline']) {
    if (typeof driver?.[method] !== 'function') {
      throw new ProtocolError(`Evolution Algorithm Driver 缺少 ${method}()`)
    }
  }
  if (!(driver.store instanceof PopulationStore)
      || typeof options.campaignsRoot !== 'string' || typeof options.campaignId !== 'string'
      || driver.store.root !== resolve(options.campaignsRoot, options.campaignId)) {
    throw new ProtocolError('Evolution Algorithm 必须使用本次 Run 的 PopulationStore')
  }
  return driver
}

registerEvolutionAlgorithm('population-v1', (options) => new PopulationOrchestrator(options))
