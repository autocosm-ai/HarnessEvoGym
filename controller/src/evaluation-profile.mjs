import { createHash } from 'node:crypto'
import { ProtocolError } from './protocol.mjs'
import { ResumeCompatibilityError } from './execution-identity.mjs'

export const EVALUATION_PROFILE_VERSION = 'harness-rsi/evaluation-profile-v1'
export const EVALUATION_MODES = Object.freeze([
  'resume',
  'sealed-final',
  'fork',
  'exploratory',
])

const STRICT_MODES = new Set(['resume', 'sealed-final'])
const SECRET_KEY_NAMES = new Set([
  'apikey',
  'accesskey',
  'accesstoken',
  'authorization',
  'bearertoken',
  'password',
  'secret',
  'privatekey',
  'credential',
  'token',
])

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function normalizeKey(value) {
  return value.replace(/[-_\s]/gu, '').toLowerCase()
}

function assertSafeJson(value, path = '$', seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ProtocolError(`评测身份 ${path} 不能包含 NaN 或 Infinity`)
    return
  }
  if (typeof value !== 'object') throw new ProtocolError(`评测身份 ${path} 只能包含 JSON 类型`)
  if (seen.has(value)) throw new ProtocolError(`评测身份 ${path} 包含循环引用`)
  seen.add(value)
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        throw new ProtocolError(`评测身份 ${path}[${index}] 不能是稀疏数组`)
      }
      assertSafeJson(value[index], `${path}[${index}]`, seen)
    }
  } else {
    if (!isPlainObject(value)) throw new ProtocolError(`评测身份 ${path} 必须是普通 JSON 对象`)
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEY_NAMES.has(normalizeKey(key))) {
        throw new ProtocolError(`评测身份 ${path}.${key} 禁止写入密钥或凭据`)
      }
      assertSafeJson(child, `${path}.${key}`, seen)
    }
  }
  seen.delete(value)
}

function cloneAndFreeze(value) {
  if (Array.isArray(value)) {
    const copy = value.map(cloneAndFreeze)
    return Object.freeze(copy)
  }
  if (isPlainObject(value)) {
    const copy = Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, cloneAndFreeze(child)]),
    )
    return Object.freeze(copy)
  }
  return value
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

function digest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function requireRunId(value, path) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,119}$/u.test(value)) {
    throw new ProtocolError(`${path} 必须是 2-120 位字母、数字、点、下划线或连字符组成的 ID`)
  }
}

export function normalizeEvaluationMode(input = 'resume') {
  if (typeof input !== 'string' || !EVALUATION_MODES.includes(input)) {
    throw new ProtocolError(`评测模式必须是：${EVALUATION_MODES.join('、')}`)
  }
  return input
}

export function isStrictEvaluationMode(mode) {
  return STRICT_MODES.has(normalizeEvaluationMode(mode))
}

export function createEvaluationIdentity({
  mode = 'resume',
  runId,
  parentRunId = null,
  evaluation = {},
} = {}) {
  const normalizedMode = normalizeEvaluationMode(mode)
  requireRunId(runId, 'runId')
  if (parentRunId !== null) requireRunId(parentRunId, 'parentRunId')
  if (normalizedMode === 'fork' && parentRunId === null) {
    throw new ProtocolError('fork 模式必须记录 parentRunId，说明它从哪个 Run 派生')
  }
  if (!isPlainObject(evaluation)) throw new ProtocolError('evaluation 必须是普通 JSON 对象')
  assertSafeJson(evaluation, 'evaluation')
  const payload = {
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'EvaluationIdentity',
    version: EVALUATION_PROFILE_VERSION,
    mode: normalizedMode,
    runId,
    parentRunId,
    evaluation: cloneAndFreeze(evaluation),
  }
  return Object.freeze({ ...payload, identityDigest: digest(payload) })
}

function assertIdentityShape(identity, label) {
  if (!isPlainObject(identity)) throw new ProtocolError(`${label} 必须是 EvaluationIdentity 对象`)
  const allowedKeys = new Set(['apiVersion', 'kind', 'version', 'mode', 'runId', 'parentRunId', 'evaluation', 'identityDigest'])
  const unknownKeys = Object.keys(identity).filter((key) => !allowedKeys.has(key))
  if (unknownKeys.length > 0) throw new ProtocolError(`${label} 含有未知字段`, unknownKeys)
  if (identity.apiVersion !== 'harness-rsi/v1alpha1' || identity.kind !== 'EvaluationIdentity') {
    throw new ProtocolError(`${label} 的 apiVersion/kind 不正确`)
  }
  if (identity.version !== EVALUATION_PROFILE_VERSION) {
    throw new ProtocolError(`${label} 的评测身份版本不受支持：${identity.version ?? '缺失'}`)
  }
  const expected = createEvaluationIdentity(identity)
  if (expected.identityDigest !== identity.identityDigest) {
    throw new ProtocolError(`${label} 的 identityDigest 校验失败`)
  }
  return expected
}

function collectDifferences(previous, next, path = '') {
  if (Object.is(previous, next)) return []
  if (!isPlainObject(previous) || !isPlainObject(next)) return [path || '$']
  const keys = [...new Set([...Object.keys(previous), ...Object.keys(next)])].sort()
  return keys.flatMap((key) => collectDifferences(previous[key], next[key], path ? `${path}.${key}` : key))
}

export function compareEvaluationIdentity(stored, current, { mode = current?.mode } = {}) {
  const previous = assertIdentityShape(stored, 'stored EvaluationIdentity')
  const next = assertIdentityShape(current, 'current EvaluationIdentity')
  const changedFields = collectDifferences(previous, next)
  if (changedFields.length === 0) {
    return { compatible: true, reuse: 'committed', changedFields: [] }
  }

  const normalizedMode = normalizeEvaluationMode(mode)
  if (isStrictEvaluationMode(normalizedMode)) {
    throw new ResumeCompatibilityError('评测身份发生变化，不能直接 resume 或伪装成正式 Final', changedFields)
  }
  return {
    compatible: false,
    reuse: 'stale',
    changedFields,
    reason: normalizedMode === 'fork'
      ? '这是新的派生 Run，旧结果只能作为历史参考，必须重新评测'
      : '这是探索性评测，旧结果不能直接当作当前配置的结果',
  }
}

export function validateEvaluationIdentity(identity) {
  return assertIdentityShape(identity, 'EvaluationIdentity')
}
