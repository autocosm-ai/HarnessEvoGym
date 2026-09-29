import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { normalizeEvolutionAlgorithm } from './evolution-algorithm-reference.mjs'
import { ProtocolError } from './protocol.mjs'

const ALGORITHM_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const CHECKPOINT_VERSION = /^v[0-9]+$/u

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError(`${label} 必须是对象`)
  }
  return value
}

function safeJson(value, label = '算法状态', seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ProtocolError(`${label} 不能包含 NaN 或 Infinity`)
    return value
  }
  if (typeof value !== 'object' || seen.has(value)) {
    throw new ProtocolError(`${label} 必须是无循环的 JSON 数据`)
  }
  seen.add(value)
  let result
  if (Array.isArray(value)) {
    result = value.map((item, index) => safeJson(item, `${label}[${index}]`, seen))
  } else {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ProtocolError(`${label} 只能包含普通 JSON 对象`)
    }
    result = Object.fromEntries(Object.keys(value).sort().map((key) => [
      key, safeJson(value[key], `${label}.${key}`, seen),
    ]))
  }
  seen.delete(value)
  return result
}

async function atomicJson(pathValue, value) {
  await mkdir(dirname(pathValue), { recursive: true, mode: 0o700 })
  const temporary = `${pathValue}.tmp-${process.pid}-${randomUUID()}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  try {
    await rename(temporary, pathValue)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

/** 一个不依赖 PopulationStore 的本地 RunStore，适合 SDK 插件和离线测试。 */
export class FileAlgorithmRunStore {
  constructor(root) {
    if (typeof root !== 'string' || root.trim().length === 0) throw new ProtocolError('RunStore root 必须是路径')
    this.root = resolve(root)
    this.statePath = join(this.root, 'state.json')
    this.eventsPath = join(this.root, 'events.jsonl')
    this.checkpointsRoot = join(this.root, 'checkpoints')
  }

  async initialize({ state, metadata = {} } = {}) {
    safeJson(state, 'RunStore state')
    await mkdir(this.root, { recursive: false, mode: 0o700 })
    await mkdir(this.checkpointsRoot, { recursive: true, mode: 0o700 })
    await atomicJson(this.statePath, state)
    await atomicJson(join(this.root, 'metadata.json'), safeJson(metadata, 'RunStore metadata'))
    await writeFile(this.eventsPath, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  }

  async readState() {
    return safeJson(JSON.parse(await readFile(this.statePath, 'utf8')), 'RunStore state')
  }

  async writeState(state) {
    return await atomicJson(this.statePath, safeJson(state, 'RunStore state'))
  }

  async appendEvent(event) {
    const value = safeJson(event, 'RunStore event')
    const text = await readFile(this.eventsPath, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return ''
      throw error
    })
    const sequence = text.trim() === '' ? 1 : text.trimEnd().split(/\r?\n/u).length + 1
    const record = { sequence, ...value }
    await writeFile(this.eventsPath, `${text}${JSON.stringify(record)}\n`, { encoding: 'utf8' })
    return record
  }

  async writeCheckpoint(name, checkpoint) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.json$/u.test(name)) {
      throw new ProtocolError('Checkpoint 名称无效')
    }
    const pathValue = join(this.checkpointsRoot, name)
    const encoded = `${JSON.stringify(safeJson(checkpoint, 'Checkpoint'), null, 2)}\n`
    try {
      await writeFile(pathValue, encoded, { encoding: 'utf8', flag: 'wx', mode: 0o400 })
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const existing = await readFile(pathValue, 'utf8')
      if (existing !== encoded) throw new ProtocolError(`Checkpoint 已存在但内容不一致：${name}`)
    }
    return { name, path: pathValue }
  }

  async readCheckpoint(name) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.json$/u.test(name)) {
      throw new ProtocolError('Checkpoint 名称无效')
    }
    try {
      return safeJson(JSON.parse(await readFile(join(this.checkpointsRoot, name), 'utf8')), 'Checkpoint')
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }
}

export function validateGenericEvolutionAlgorithm(driver) {
  object(driver, 'Algorithm Driver')
  for (const method of ['initialize', 'step', 'resume', 'report', 'freezeBaseline']) {
    if (typeof driver[method] !== 'function') throw new ProtocolError(`通用 Algorithm Driver 缺少 ${method}()`)
  }
  object(driver.store, 'Algorithm Driver.store')
  const codec = object(driver.checkpointCodec, 'Algorithm Driver.checkpointCodec')
  if (typeof codec.version !== 'string' || !CHECKPOINT_VERSION.test(codec.version)
      || typeof codec.encode !== 'function' || typeof codec.decode !== 'function') {
    throw new ProtocolError('Algorithm CheckpointCodec 必须包含 vN version、encode() 和 decode()')
  }
  return driver
}

const GENERIC_FACTORIES = new Map()

export function registerGenericEvolutionAlgorithm(id, factory) {
  if (typeof id !== 'string' || !ALGORITHM_ID.test(id)) throw new ProtocolError('通用 Algorithm ID 必须是 kebab-case')
  if (typeof factory !== 'function') throw new ProtocolError('通用 Algorithm Factory 必须是函数')
  if (GENERIC_FACTORIES.has(id)) throw new ProtocolError(`通用 Algorithm 重复注册：${id}`)
  GENERIC_FACTORIES.set(id, factory)
}

export function registeredGenericEvolutionAlgorithms() {
  return Object.freeze([...GENERIC_FACTORIES.keys()].sort())
}

export function createGenericEvolutionAlgorithmDriver({ algorithm, options = {} } = {}) {
  const reference = normalizeEvolutionAlgorithm(algorithm)
  if (!reference || !GENERIC_FACTORIES.has(reference.id)) {
    throw new ProtocolError(`未注册通用 Evolution Algorithm：${reference?.id ?? '(missing)'}`)
  }
  return validateGenericEvolutionAlgorithm(
    GENERIC_FACTORIES.get(reference.id)({ ...options, algorithm: reference }),
  )
}

function normalizeStepResult(result, previous) {
  if (result === undefined || result === null) return { state: previous, done: false, checkpoint: null, event: null }
  const value = object(result, 'Algorithm step result')
  const state = value.state === undefined ? previous : safeJson(value.state, 'Algorithm step state')
  return {
    state,
    done: value.done === true || ['completed', 'failed', 'paused'].includes(state.status),
    checkpoint: value.checkpoint ?? null,
    event: value.event ?? null,
  }
}

async function writeCheckpointWithCollisionRetry(store, baseName, checkpoint) {
  for (let suffix = 0; suffix < 10_000; suffix += 1) {
    const name = suffix === 0
      ? baseName
      : baseName.replace(/\.json$/u, `-${String(suffix).padStart(2, '0')}.json`)
    try {
      return await store.writeCheckpoint(name, checkpoint)
    } catch (error) {
      const collision = error?.code === 'EEXIST'
        || (typeof error?.message === 'string' && /已存在但内容不一致/u.test(error.message))
      if (!collision) throw error
    }
  }
  throw new ProtocolError(`Checkpoint 名称冲突次数超过上限：${baseName}`)
}

/** 通用算法宿主只理解生命周期和 Checkpoint，不理解算法的私有状态结构。 */
export async function runGenericEvolution({
  driver,
  initialState = { status: 'active', step: 0 },
  context = {},
  maxSteps = 1,
  resume = false,
  baselineOnly = false,
  checkpointPrefix = 'step',
} = {}) {
  const algorithm = validateGenericEvolutionAlgorithm(driver)
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 0 || maxSteps > 100_000) {
    throw new ProtocolError('通用 Algorithm maxSteps 必须是 0..100000 的整数')
  }
  let state = resume
    ? await algorithm.store.readState()
    : safeJson(initialState, 'Algorithm initialState')
  if (!resume) await algorithm.store.initialize({ state })
  const lifecycle = resume ? algorithm.resume : algorithm.initialize
  state = safeJson(await lifecycle.call(algorithm, { state, context, store: algorithm.store }), 'Algorithm state')
  await algorithm.store.writeState(state)
  if (baselineOnly) {
    state = safeJson(
      await algorithm.freezeBaseline({ state, context, store: algorithm.store }),
      'Algorithm baseline state',
    )
    await algorithm.store.writeState(state)
    const report = await algorithm.report({ state, context, store: algorithm.store })
    return { state, report, steps: 0, complete: true }
  }
  let steps = 0
  while (steps < maxSteps && !['completed', 'failed', 'paused'].includes(state.status)) {
    const result = normalizeStepResult(
      await algorithm.step({ state, context, store: algorithm.store }),
      state,
    )
    state = result.state
    steps += 1
    await algorithm.store.writeState(state)
    if (result.checkpoint !== null) {
      const encoded = algorithm.checkpointCodec.encode(result.checkpoint)
      await writeCheckpointWithCollisionRetry(algorithm.store,
        `${checkpointPrefix}-${String(steps).padStart(6, '0')}.json`,
        { version: algorithm.checkpointCodec.version, step: steps, state: safeJson(encoded, 'Checkpoint encoded state') },
      )
    }
    if (result.event !== null) await algorithm.store.appendEvent(result.event)
    if (result.done) break
  }
  const report = await algorithm.report({ state, context, store: algorithm.store })
  return { state, report, steps, complete: ['completed', 'failed'].includes(state.status) }
}
