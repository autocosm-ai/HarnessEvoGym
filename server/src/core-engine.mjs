import { spawn } from 'node:child_process'
import { appendFile, mkdir, open, readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

import { assertEvolutionAlgorithmAvailable } from '../../controller/src/evolution-algorithm.mjs'
import { loadExperimentBundle } from '../../controller/src/adapters.mjs'
import { assertPathKind, resolveInside } from '../../controller/src/config.mjs'
import { ProtocolError, readJsonFile, writeJsonFile } from '../../controller/src/protocol.mjs'
import { createRunId } from '../../controller/src/cowork-orchestrator.mjs'

const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,119}$/u
const MAX_EVENT_BYTES = 8 * 1024
const MAX_SERVER_EVENTS = 100_000
const MAX_EVENT_LOG_BYTES = 64 * 1024 * 1024

function assertRunId(value) {
  if (typeof value !== 'string' || !RUN_ID_PATTERN.test(value)) {
    throw new ProtocolError('Run ID 只能包含小写字母、数字、点、下划线和连字符，长度为 3-120')
  }
  return value
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function safeEventDetails(value, label = '事件详情', seen = new Set()) {
  if (!isObject(value)) throw new ProtocolError(`${label} 必须是 JSON 对象`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ProtocolError(`${label} 必须是普通 JSON 对象`)
  }
  if (seen.has(value)) throw new ProtocolError(`${label} 不能包含循环引用`)
  seen.add(value)
  const output = {}
  for (const key of Object.keys(value)) {
    if (typeof key !== 'string' || /[\u0000-\u001f\u007f]/u.test(key)) {
      throw new ProtocolError(`${label} 含有非法字段名`)
    }
    const item = value[key]
    if (item === null || typeof item === 'string' || typeof item === 'boolean') output[key] = item
    else if (typeof item === 'number' && Number.isFinite(item)) output[key] = item
    else if (Array.isArray(item)) {
      output[key] = item.map((entry, index) => safeEventValue(entry, `${label}.${key}[${index}]`, seen))
    } else if (isObject(item)) {
      output[key] = safeEventDetails(item, `${label}.${key}`, seen)
    } else {
      throw new ProtocolError(`${label}.${key} 必须是 JSON 值`)
    }
  }
  seen.delete(value)
  return output
}

function safeEventValue(value, label, seen) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new ProtocolError(`${label} 不能包含循环引用`)
    seen.add(value)
    const result = value.map((entry, index) => safeEventValue(entry, `${label}[${index}]`, seen))
    seen.delete(value)
    return result
  }
  return safeEventDetails(value, label, seen)
}

function now(clock) {
  return new Date(clock()).toISOString()
}

function isInside(root, child) {
  const relation = relative(resolve(root), resolve(child))
  return relation === '' || (!relation.startsWith('../') && relation !== '..' && !relation.startsWith('/'))
}

function publicMessage(value, repositoryRoot) {
  let text = String(value).replaceAll(repositoryRoot, '<repository>')
  for (const secret of [
    process.env.RSI_PROVIDER_API_KEY,
    process.env.ANTHROPIC_API_KEY,
    process.env.OPENAI_API_KEY,
    process.env.ZCLOUD_API_KEY,
  ]) {
    if (typeof secret === 'string' && secret.length >= 4) text = text.replaceAll(secret, '[REDACTED]')
  }
  text = text.replace(/(?:sk|key)-[A-Za-z0-9_-]{12,}/gu, '[REDACTED]')
  return text.slice(0, MAX_EVENT_BYTES)
}

function publicDescriptor(descriptor) {
  return {
    apiVersion: descriptor.apiVersion,
    kind: descriptor.kind,
    runId: descriptor.runId,
    status: descriptor.status,
    operation: descriptor.operation,
    parentRunId: descriptor.parentRunId ?? null,
    parentCheckpoint: descriptor.parentCheckpoint ?? null,
    evaluationMode: descriptor.evaluationMode ?? 'standard',
    experimentPath: descriptor.experimentPath,
    population: descriptor.population,
    runRoot: descriptor.runRoot,
    pid: descriptor.status === 'running' ? descriptor.pid : null,
    createdAt: descriptor.createdAt,
    updatedAt: descriptor.updatedAt,
    completedAt: descriptor.completedAt ?? null,
    error: descriptor.status === 'failed' ? descriptor.error ?? 'Core Engine 执行失败' : null,
  }
}

function terminalFromCoreState(state) {
  if (!isObject(state)) return null
  const status = state.status ?? state.metadata?.status
  if (['CLOSED', 'REPORTED', 'completed'].includes(status)) return 'completed'
  if (['PAUSED_INFRASTRUCTURE', 'paused', 'PAUSED'].includes(status)) return 'paused'
  if (['FAILED', 'failed'].includes(status)) return 'failed'
  if (['EVOLVING', 'active', 'running'].includes(status)) return 'running'
  return null
}

async function readJsonLines(pathValue) {
  try {
    await assertPathKind(pathValue, 'Run event log', 'file')
    const info = await stat(pathValue)
    if (info.size > MAX_EVENT_LOG_BYTES) {
      throw new ProtocolError(`Run event log 超过 ${MAX_EVENT_LOG_BYTES} 字节上限`)
    }
    const text = await readFile(pathValue, 'utf8')
    return text.split(/\r?\n/u).filter(Boolean).map((line, index) => {
      if (Buffer.byteLength(line, 'utf8') > MAX_EVENT_BYTES) {
        throw new ProtocolError(`Run event log 第 ${index + 1} 行超过 ${MAX_EVENT_BYTES} 字节上限`)
      }
      try {
        return JSON.parse(line)
      } catch (error) {
        throw new ProtocolError(`Run event log 第 ${index + 1} 行格式错误`, [error.message])
      }
    })
  } catch (error) {
    if (error instanceof ProtocolError && /不存在/u.test(error.message)) return []
    throw error
  }
}

/**
 * Server API 使用的 Core Engine 门面。
 *
 * 这里不实现 Solver/Updater，也不接受候选代码命令。它只负责把一个受信的
 * Controller CLI 运行作为可持久化 Run 管理，并把运行状态投影给 API。
 * 后续可以把 processFactory 换成独立 Worker，而不改变 HTTP 契约。
 */
export class CoreEngine {
  constructor({
    repositoryRoot,
    runsRoot = join(repositoryRoot, '.rsi', 'server', 'runs'),
    cliPath = join(repositoryRoot, 'controller', 'src', 'cli.mjs'),
    processFactory = spawn,
    clock = Date.now,
  } = {}) {
    if (typeof repositoryRoot !== 'string' || repositoryRoot.length === 0) {
      throw new ProtocolError('CoreEngine repositoryRoot 必须是非空路径')
    }
    this.repositoryRoot = resolve(repositoryRoot)
    this.runsRoot = resolve(runsRoot)
    this.cliPath = resolve(cliPath)
    this.processFactory = processFactory
    this.clock = clock
    this.processes = new Map()
    this.eventTails = new Map()
    this.eventSequences = new Map()
    this.coreEventTails = new Map()
    this.controlTails = new Map()
    this.descriptorTails = new Map()
  }

  descriptorPath(runId) {
    assertRunId(runId)
    return join(this.runsRoot, `${runId}.json`)
  }

  eventsPath(runId) {
    assertRunId(runId)
    return join(this.runsRoot, `${runId}.events.jsonl`)
  }

  async readDescriptor(runId) {
    return await readJsonFile(this.descriptorPath(runId))
  }

  async writeDescriptor(descriptor) {
    return await this.withDescriptorLock(descriptor.runId, async () => {
      await writeJsonFile(this.descriptorPath(descriptor.runId), descriptor)
      return descriptor
    })
  }

  async createDescriptor(descriptor) {
    await mkdir(this.runsRoot, { recursive: true })
    const pathValue = this.descriptorPath(descriptor.runId)
    const handle = await open(pathValue, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(descriptor, null, 2)}\n`, 'utf8')
    } finally {
      await handle.close()
    }
    return descriptor
  }

  async withDescriptorLock(runId, operation) {
    const previous = this.descriptorTails.get(runId) ?? Promise.resolve()
    const current = previous.then(operation, operation)
    this.descriptorTails.set(runId, current)
    try {
      return await current
    } finally {
      if (this.descriptorTails.get(runId) === current) this.descriptorTails.delete(runId)
    }
  }

  async event(runId, type, details = {}) {
    assertRunId(runId)
    if (typeof type !== 'string' || type.length === 0 || /[\u0000\r\n]/u.test(type)) {
      throw new ProtocolError('Run 事件类型必须是安全的非空字符串')
    }
    const safeDetails = safeEventDetails(details)
    const previous = this.eventTails.get(runId) ?? Promise.resolve()
    const append = async () => {
      const pathValue = this.eventsPath(runId)
      await mkdir(dirname(pathValue), { recursive: true })
      let sequence = this.eventSequences.get(runId)
      if (sequence === undefined) {
        const events = await readJsonLines(pathValue)
        sequence = events.at(-1)?.sequence ?? 0
      }
      if (sequence >= MAX_SERVER_EVENTS) {
        throw new ProtocolError(`Run 事件数量超过上限 ${MAX_SERVER_EVENTS}，请归档后再继续`)
      }
      const record = {
        ...safeDetails,
        apiVersion: 'harness-evo-gym/v1',
        kind: 'RunEvent',
        sequence: sequence + 1,
        runId,
        type,
        at: now(this.clock),
      }
      const serialized = JSON.stringify(record)
      if (Buffer.byteLength(serialized, 'utf8') > MAX_EVENT_BYTES) {
        throw new ProtocolError(`Run 事件超过 ${MAX_EVENT_BYTES} 字节上限`)
      }
      await appendFile(pathValue, `${serialized}\n`, 'utf8')
      this.eventSequences.set(runId, record.sequence)
      return record
    }
    const current = previous.then(append, append)
    this.eventTails.set(runId, current)
    try {
      return await current
    } finally {
      if (this.eventTails.get(runId) === current) this.eventTails.delete(runId)
    }
  }

  async updateDescriptor(runId, patch) {
    return await this.withDescriptorLock(runId, async () => {
      const descriptor = await this.readDescriptor(runId)
      const next = { ...descriptor, ...patch, updatedAt: now(this.clock) }
      await writeJsonFile(this.descriptorPath(runId), next)
      return next
    })
  }

  async validateExperiment(experimentPath) {
    if (typeof experimentPath !== 'string' || experimentPath.length === 0) {
      throw new ProtocolError('experimentPath 必须是非空相对路径')
    }
    const absolute = resolveInside(this.repositoryRoot, experimentPath, 'Experiment 路径')
    await assertPathKind(absolute, 'Experiment 配置', 'file')
    const bundle = await loadExperimentBundle(absolute, this.repositoryRoot)
    assertEvolutionAlgorithmAvailable(bundle.recipe.spec.algorithm)
    return { absolute, bundle }
  }

  async expectedRunRoot(runId, bundle) {
    const runtimeRoot = resolveInside(
      this.repositoryRoot,
      bundle.target.materialization.runtimeRoot,
      'Target Runtime Root',
    )
    const root = bundle.experiment.recipePath === null
      ? join(runtimeRoot, runId)
      : join(runtimeRoot, 'populations', runId)
    if (!isInside(this.repositoryRoot, root)) {
      throw new ProtocolError('Experiment Runtime Root 不能逃逸仓库目录')
    }
    return root
  }

  async createRun({ experimentPath, runId = createRunId('server-run') } = {}) {
    assertRunId(runId)
    const { absolute, bundle } = await this.validateExperiment(experimentPath)
    const descriptorPath = this.descriptorPath(runId)
    try {
      await assertPathKind(descriptorPath, 'Server Run Descriptor', 'file')
      throw new ProtocolError(`Run 已存在：${runId}`)
    } catch (error) {
      if (!(error instanceof ProtocolError) || !/不存在/u.test(error.message)) throw error
    }
    const runRoot = await this.expectedRunRoot(runId, bundle)
    const descriptor = {
      apiVersion: 'harness-evo-gym/v1',
      kind: 'CoreEngineRun',
      runId,
      status: 'queued',
      operation: 'run',
      experimentPath: relative(this.repositoryRoot, absolute).replaceAll('\\', '/'),
      runRoot: relative(this.repositoryRoot, runRoot).replaceAll('\\', '/'),
      population: bundle.experiment.recipePath !== null,
      pid: null,
      createdAt: now(this.clock),
      updatedAt: now(this.clock),
    }
    try {
      await this.createDescriptor(descriptor)
    } catch (error) {
      if (error.code === 'EEXIST') throw new ProtocolError(`Run 已存在：${runId}`)
      throw error
    }
    await this.event(runId, 'run.queued', { operation: 'run' })
    await this.startProcess(descriptor, ['experiment', 'run', '--config', absolute, '--run-id', runId])
    return publicDescriptor(await this.readDescriptor(runId))
  }

  /**
   * 从一个已经存在的 Population Run 的 Checkpoint 创建新 Run。
   *
   * Server 只负责记录父子关系并启动受信 Controller；Checkpoint 的完整性、
   * Candidate Workspace 复制和新 Baseline 重算由 Controller 的 fork 入口负责。
   */
  async forkRun(
    parentRunId,
    {
      runId = createRunId('server-fork'),
      checkpoint = null,
      experimentPath = null,
    } = {},
  ) {
    assertRunId(parentRunId)
    assertRunId(runId)
    if (parentRunId === runId) throw new ProtocolError('Fork Run ID 不能和 Parent Run 相同')
    const parent = await this.readDescriptor(parentRunId)
    if (parent.population !== true) throw new ProtocolError('只有 Population Run 才能 Fork')
    const parentRoot = resolveInside(this.repositoryRoot, parent.runRoot, 'Parent Run Root')
    await assertPathKind(parentRoot, 'Parent Run Root')

    const selectedExperiment = experimentPath ?? parent.experimentPath
    const { absolute: experimentAbsolute, bundle } = await this.validateExperiment(selectedExperiment)
    if (bundle.experiment.recipePath === null) throw new ProtocolError('Fork 目标必须是 Population Experiment')
    let checkpointArgument = null
    if (checkpoint !== null && checkpoint !== undefined) {
      if (typeof checkpoint !== 'string' || checkpoint.length === 0 || checkpoint.startsWith('/')) {
        throw new ProtocolError('checkpoint 必须是 Parent Run 内的相对路径')
      }
      const checkpointAbsolute = resolveInside(parentRoot, checkpoint, 'Fork Checkpoint')
      await assertPathKind(checkpointAbsolute, 'Fork Checkpoint', 'file')
      checkpointArgument = relative(parentRoot, checkpointAbsolute).replaceAll('\\', '/')
    }

    const descriptorPath = this.descriptorPath(runId)
    try {
      await assertPathKind(descriptorPath, 'Server Run Descriptor', 'file')
      throw new ProtocolError(`Run 已存在：${runId}`)
    } catch (error) {
      if (!(error instanceof ProtocolError) || !/不存在/u.test(error.message)) throw error
    }
    const runRoot = await this.expectedRunRoot(runId, bundle)
    const descriptor = {
      apiVersion: 'harness-evo-gym/v1',
      kind: 'CoreEngineRun',
      runId,
      status: 'queued',
      operation: 'fork',
      parentRunId,
      parentCheckpoint: checkpointArgument,
      evaluationMode: 'fork',
      experimentPath: relative(this.repositoryRoot, experimentAbsolute).replaceAll('\\', '/'),
      runRoot: relative(this.repositoryRoot, runRoot).replaceAll('\\', '/'),
      population: true,
      pid: null,
      createdAt: now(this.clock),
      updatedAt: now(this.clock),
    }
    try {
      await this.createDescriptor(descriptor)
    } catch (error) {
      if (error.code === 'EEXIST') throw new ProtocolError(`Run 已存在：${runId}`)
      throw error
    }
    await this.event(runId, 'run.queued', {
      operation: 'fork',
      parentRunId,
      parentCheckpoint: checkpointArgument,
    })
    const args = [
      'experiment',
      'fork',
      '--run',
      parentRoot,
      '--run-id',
      runId,
      '--config',
      relative(this.repositoryRoot, experimentAbsolute).replaceAll('\\', '/'),
    ]
    if (checkpointArgument !== null) args.push('--checkpoint', checkpointArgument)
    await this.startProcess(descriptor, args)
    return publicDescriptor(await this.readDescriptor(runId))
  }

  async startProcess(descriptor, args) {
    let child
    try {
      child = this.processFactory(process.execPath, [this.cliPath, ...args], {
        cwd: this.repositoryRoot,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      await this.updateDescriptor(descriptor.runId, {
        status: 'failed',
        error: publicMessage(error.message, this.repositoryRoot),
        completedAt: now(this.clock),
      })
      await this.event(descriptor.runId, 'run.failed', {
        message: publicMessage(error.message, this.repositoryRoot),
      })
      return
    }
    this.processes.set(descriptor.runId, child)
    let settled = false
    let ready
    const markSettled = () => {
      if (settled) return false
      settled = true
      return true
    }

    const onOutput = (chunk) => {
      const text = String(chunk).trim()
      if (!text) return
      const message = text.slice(0, MAX_EVENT_BYTES)
      void this.event(descriptor.runId, 'core.output', {
        stream: 'stderr',
        message: publicMessage(message, this.repositoryRoot),
      }).catch(() => {})
    }
    child.stderr?.on('data', onOutput)
    child.stdout?.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text) void this.event(descriptor.runId, 'core.result', {
        message: publicMessage(text, this.repositoryRoot),
      }).catch(() => {})
    })
    child.once('error', (error) => {
      if (!markSettled()) return
      void Promise.resolve().then(() => ready).then(() => this.updateDescriptor(descriptor.runId, {
        status: 'failed',
        pid: null,
        error: publicMessage(error.message, this.repositoryRoot),
        completedAt: now(this.clock),
      })).then(() => this.event(descriptor.runId, 'run.failed', {
        message: publicMessage(error.message, this.repositoryRoot),
      })).finally(() => {
        if (this.processes.get(descriptor.runId) === child) this.processes.delete(descriptor.runId)
      }).catch(() => {})
    })
    child.once('close', (code, signal) => {
      if (!markSettled()) return
      void Promise.resolve().then(() => ready).then(() => this.readDescriptor(descriptor.runId)).then(async (current) => {
        const cancelled = current.status === 'cancelling'
        let mapped = null
        let stateError = null
        if (code === 0 && !cancelled) {
          try { mapped = terminalFromCoreState(await this.readCoreState(current)) }
          catch (error) { stateError = publicMessage(error.message, this.repositoryRoot) }
          if (!stateError && !['completed', 'paused', 'failed'].includes(mapped)) {
            stateError = 'Core Engine 进程正常退出，但没有留下合法的终态状态文件'
          }
        }
        const status = cancelled ? 'cancelled' : stateError ? 'failed'
          : code === 0 ? (mapped === 'paused' ? 'paused' : mapped === 'failed' ? 'failed' : 'completed') : 'failed'
        return this.updateDescriptor(descriptor.runId, {
          status,
          pid: null,
          completedAt: now(this.clock),
          error: status === 'failed' ? stateError ?? `Core Engine 退出：code=${code ?? 'null'}, signal=${signal ?? 'null'}` : null,
        })
      }).then((next) => this.event(descriptor.runId, `run.${next.status}`, {
        code: code ?? null,
        signal: signal ?? null,
      })).finally(() => {
        if (this.processes.get(descriptor.runId) === child) this.processes.delete(descriptor.runId)
      }).catch(() => {})
    })
    // 必须先安装 error/close 监听；spawn 失败可能在第一次文件 I/O 完成前发生。
    ready = (async () => {
      await this.updateDescriptor(descriptor.runId, { status: 'running', pid: child.pid ?? null })
      await this.event(descriptor.runId, 'run.started', { pid: child.pid ?? null })
    })()
    await ready
  }

  async refreshRun(runId) {
    const descriptor = await this.readDescriptor(runId)
    const child = this.processes.get(runId)
    if (descriptor.status === 'running' && !child && descriptor.pid !== null) {
      try {
        process.kill(descriptor.pid, 0)
      } catch {
        const coreState = await this.readCoreState(descriptor)
        const mapped = terminalFromCoreState(coreState)
        if (mapped && mapped !== 'running') {
          return publicDescriptor(await this.updateDescriptor(runId, {
            status: mapped,
            pid: null,
            completedAt: now(this.clock),
          }))
        }
        if (mapped === 'running') {
          return publicDescriptor(await this.updateDescriptor(runId, {
            status: 'paused', pid: null,
            error: 'Core Engine 已中断，可从已提交状态恢复',
          }))
        }
        if (!mapped) {
          return publicDescriptor(await this.updateDescriptor(runId, {
            status: 'failed',
            pid: null,
            error: 'Core Engine 进程已退出，但没有留下合法状态文件',
            completedAt: now(this.clock),
          }))
        }
      }
    }
    return publicDescriptor(descriptor)
  }

  async readCoreState(descriptor) {
    const runRoot = resolveInside(this.repositoryRoot, descriptor.runRoot, 'Run Root')
    const statePath = descriptor.population
      ? join(runRoot, 'public', 'state.json')
      : join(runRoot, 'state.json')
    try {
      return await readJsonFile(statePath)
    } catch (error) {
      if (error instanceof ProtocolError
          && (/(?:不存在|ENOENT|no such file)/iu.test(error.message)
            || error.details?.some((detail) => /(?:ENOENT|no such file)/iu.test(String(detail))))) return null
      throw error
    }
  }

  async getRun(runId) {
    return await this.refreshRun(runId)
  }

  async listRuns() {
    await mkdir(this.runsRoot, { recursive: true })
    const names = (await readdir(this.runsRoot)).filter((name) => name.endsWith('.json'))
    const descriptors = await Promise.all(names.map((name) => this.getRun(name.slice(0, -5))))
    return descriptors.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  async controlRun(runId, action) {
    const previous = this.controlTails.get(runId) ?? Promise.resolve()
    const operation = () => this.controlRunUnlocked(runId, action)
    const current = previous.then(operation, operation)
    this.controlTails.set(runId, current)
    try { return await current }
    finally {
      // 清理不影响已排队操作；后者仍持有 previous Promise。
      if (this.controlTails.get(runId) === current) this.controlTails.delete(runId)
    }
  }

  async controlRunUnlocked(runId, action) {
    const descriptor = await this.readDescriptor(runId)
    if (action === 'refresh') return await this.getRun(runId)
    if (action === 'cancel') {
      const child = this.processes.get(runId)
      if (!child || !['running', 'cancelling'].includes(descriptor.status)) {
        throw new ProtocolError('只有正在运行的 Run 可以取消')
      }
      await this.updateDescriptor(runId, { status: 'cancelling' })
      await this.event(runId, 'run.cancelling')
      child.kill('SIGTERM')
      const killTimer = setTimeout(() => {
        if (this.processes.get(runId) === child) child.kill('SIGKILL')
      }, 5_000)
      killTimer.unref()
      return await this.getRun(runId)
    }
    if (action === 'resume') {
      if (!['paused', 'failed'].includes(descriptor.status)) {
        throw new ProtocolError('只有 paused 或 failed 的 Run 可以 Resume')
      }
      if (!descriptor.population) throw new ProtocolError('旧版单 Run 暂不支持 Server Resume；请使用 Population Run')
      const runRoot = resolveInside(this.repositoryRoot, descriptor.runRoot, 'Run Root')
      const next = await this.updateDescriptor(runId, { status: 'queued', operation: 'resume', error: null, completedAt: null })
      await this.event(runId, 'run.queued', { operation: 'resume' })
      await this.startProcess(next, ['experiment', 'resume', '--run', runRoot])
      return publicDescriptor(await this.readDescriptor(runId))
    }
    throw new ProtocolError(`不支持的 Run 控制动作：${action}`)
  }

  async getEvents(runId, after = 0) {
    const previous = this.coreEventTails.get(runId) ?? Promise.resolve()
    const current = previous.then(() => this.collectEvents(runId, after), () => this.collectEvents(runId, after))
    this.coreEventTails.set(runId, current)
    try { return await current }
    finally { if (this.coreEventTails.get(runId) === current) this.coreEventTails.delete(runId) }
  }

  async collectEvents(runId, after = 0) {
    if (!Number.isSafeInteger(after) || after < 0) throw new ProtocolError('after 必须是非负整数')
    const descriptor = await this.readDescriptor(runId)
    const serverEvents = await readJsonLines(this.eventsPath(runId))
    const runRoot = resolveInside(this.repositoryRoot, descriptor.runRoot, 'Run Root')
    const corePath = descriptor.population
      ? join(runRoot, 'public', 'events.jsonl')
      : join(runRoot, 'state.json')
    let coreEvents = []
    if (descriptor.population) coreEvents = await readJsonLines(corePath)
    else {
      try {
        const state = await readJsonFile(corePath)
        coreEvents = Array.isArray(state.events) ? state.events : []
      } catch (error) {
        if (!(error instanceof ProtocolError && /不存在/u.test(error.message))) throw error
      }
    }
    // 核心事件只导入一次，使用同一条持久化序号；后续 Server 事件不能给旧事件重新编号。
    const imported = serverEvents.filter((event) => event.source === 'core').length
    for (let index = imported; index < coreEvents.length; index += 1) {
      const event = coreEvents[index]
      await this.event(runId, event.type ?? 'core.event', {
        source: 'core', coreSequence: index + 1, coreAt: event.at ?? null, details: event,
      })
    }
    const combined = await readJsonLines(this.eventsPath(runId))
    return combined.filter((event) => event.sequence > after).slice(0, 1000)
  }

  async getVersions(runId) {
    const descriptor = await this.readDescriptor(runId)
    const runRoot = resolveInside(this.repositoryRoot, descriptor.runRoot, 'Run Root')
    const state = await this.readCoreState(descriptor)
    const reportPath = join(runRoot, 'report', 'best-harness.json')
    let report = null
    try { report = await readJsonFile(reportPath) } catch {}
    const branches = Array.isArray(state?.branches)
      ? state.branches.map((branch) => ({
          branchId: branch.branchId ?? null,
          status: branch.status ?? null,
          candidateId: branch.incumbent?.candidateId ?? null,
          revision: branch.incumbent?.revision ?? null,
          digest: branch.incumbent?.digest ?? null,
        }))
      : []
    return {
      apiVersion: 'harness-evo-gym/v1',
      kind: 'RunVersions',
      runId,
      best: state?.best ? {
        branchId: state.best.branchId ?? null,
        candidateId: state.best.candidateId ?? null,
        revision: state.best.revision ?? null,
        digest: state.best.digest ?? null,
      } : null,
      branches,
      report: report ? {
        candidateId: report.candidateId ?? null,
        revision: report.revision ?? null,
        digest: report.digest ?? null,
      } : null,
    }
  }
}

export { assertRunId, publicDescriptor }
