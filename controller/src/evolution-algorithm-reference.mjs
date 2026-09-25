import { ProtocolError } from './protocol.mjs'

export const EVOLUTION_ALGORITHM_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

function cloneJson(value, seen = new Set(), depth = 0) {
  if (depth > 64) throw new ProtocolError('Algorithm configuration 嵌套过深')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (!value || typeof value !== 'object'
      || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) {
    throw new ProtocolError('Algorithm configuration 必须是有限数字组成的普通 JSON')
  }
  if (seen.has(value)) throw new ProtocolError('Algorithm configuration 不能有循环引用')
  seen.add(value)
  const result = Array.isArray(value) ? [] : {}
  const keys = Reflect.ownKeys(value).filter((key) => !(Array.isArray(value) && key === 'length'))
  if (Array.isArray(value) && keys.length !== value.length) {
    throw new ProtocolError('Algorithm configuration 不允许稀疏数组')
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)
        || (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/u.test(key))) {
      throw new ProtocolError('Algorithm configuration 包含非 JSON 属性')
    }
    Object.defineProperty(result, key, {
      value: cloneJson(descriptor.value, seen, depth + 1), enumerable: true,
    })
  }
  seen.delete(value)
  return Object.freeze(result)
}

// 与运行时注册表分开，读取 Recipe 不需要加载 Population 编排器。
export function normalizeEvolutionAlgorithm(input) {
  if (input === undefined || input === null) return null
  const reference = typeof input === 'string' ? { id: input } : input
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)) {
    throw new ProtocolError('EvolutionRecipe.spec.algorithm 必须是 ID 或对象')
  }
  const unknown = Object.keys(reference).filter((key) => !['id', 'configuration'].includes(key))
  if (unknown.length) throw new ProtocolError('EvolutionRecipe.spec.algorithm 含有未知字段', unknown)
  if (typeof reference.id !== 'string' || !EVOLUTION_ALGORITHM_ID.test(reference.id)) {
    throw new ProtocolError('EvolutionRecipe.spec.algorithm.id 必须是 kebab-case')
  }
  const source = reference.configuration === undefined ? {} : reference.configuration
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw new ProtocolError('EvolutionRecipe.spec.algorithm.configuration 必须是 JSON 对象')
  }
  const configuration = cloneJson(source)
  if (Buffer.byteLength(JSON.stringify(configuration), 'utf8') > 64 * 1024) {
    throw new ProtocolError('Algorithm configuration 超过 65536 bytes')
  }
  return Object.freeze({ id: reference.id, configuration })
}
