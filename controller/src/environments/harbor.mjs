import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

import { writeJsonLines } from '../candidate.mjs'
import { ProtocolError, validateResultRecords } from '../protocol.mjs'
import { summarizeCtrf } from '../ctrf.mjs'
import { resolveInside } from '../config.mjs'
import { safeDockerName } from '../docker.mjs'
import { withGlobalPermit } from '../global-concurrency.mjs'
import { SolverFailure, SOLVER_FAILURE_PROTOCOL } from '../solver-failure.mjs'
import { validateInfrastructureRetries, withTrialInfrastructureRetries } from '../trial-infrastructure-retry.mjs'
import { reserveFinalTrialAttempt } from '../final-suite-store.mjs'
import {
  commitTrialCheckpoint,
  inspectTrialCheckpoint,
  quarantineTrialTask,
} from '../trial-checkpoint-store.mjs'
import { loadHarborTask } from './harbor-task.mjs'

const PARTITIONS = Object.freeze(['feedback', 'selection', 'final'])
const RUNTIME_BUILDS = new Map()
const MAXIMUM_REWARD_BYTES = 128
const MAXIMUM_CTRF_BYTES = 4 * 1024 * 1024
const MAXIMUM_WORKSPACE_ENTRIES = 20_000

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function safeSegment(value, label) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value)) {
    throw new ProtocolError(`${label} 不是安全标识：${value}`)
  }
  return value
}

function assertInside(root, pathValue, label) {
  const rel = relative(resolve(root), resolve(pathValue))
  if (rel === '..' || rel.startsWith('../') || resolve(rel) === '/') {
    throw new ProtocolError(`${label} 逃逸受控目录：${pathValue}`)
  }
}

async function assertNoSymlinkAncestors(pathValue, root, label) {
  const rootPath = resolve(root)
  const targetPath = resolve(pathValue)
  assertInside(rootPath, targetPath, label)
  const rel = relative(rootPath, targetPath)
  let current = rootPath
  for (const segment of rel.split('/').filter(Boolean).slice(0, -1)) {
    current = join(current, segment)
    const info = await lstat(current)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new ProtocolError(`${label} 的目录链不安全：${current}`)
    }
  }
}

async function inspectWorkspaceTree(root, maximumBytes, label) {
  const rootPath = resolve(root)
  const rootInfo = await lstat(rootPath).catch((error) => {
    throw new ProtocolError(`${label} 不存在`, [error.message])
  })
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new ProtocolError(`${label} 必须是普通目录`)
  }
  let entries = 0
  let totalBytes = 0
  async function visit(directory) {
    const names = (await readdir(directory)).sort()
    for (const name of names) {
      if (++entries > MAXIMUM_WORKSPACE_ENTRIES) {
        throw new ProtocolError(`${label} 文件数量超过 ${MAXIMUM_WORKSPACE_ENTRIES}`)
      }
      const pathValue = join(directory, name)
      const info = await lstat(pathValue)
      if (info.isSymbolicLink()) throw new ProtocolError(`${label} 禁止符号链接：${pathValue}`)
      if (info.isDirectory()) {
        await visit(pathValue)
      } else if (info.isFile() && info.nlink === 1) {
        totalBytes += info.size
        if (totalBytes > maximumBytes) {
          throw new ProtocolError(`${label} 超过磁盘预算`, [`bytes=${totalBytes}`, `maximum=${maximumBytes}`])
        }
      } else {
        throw new ProtocolError(`${label} 含有不支持的文件类型：${pathValue}`)
      }
    }
  }
  await visit(rootPath)
  return Object.freeze({ entries, totalBytes })
}

async function readRegularBytes(pathValue, label, maximumBytes) {
  let handle
  try {
    handle = await open(pathValue, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const info = await handle.stat()
    if (!info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > maximumBytes) throw new Error('不是大小合规的独立普通文件')
    return await handle.readFile()
  } catch (error) {
    throw new ProtocolError(`${label} 不安全或不可读`, [error.message])
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function readRegularText(pathValue, label, maximumBytes) {
  return (await readRegularBytes(pathValue, label, maximumBytes)).toString('utf8').trim()
}

async function copyRegularFile(source, target, label, maximumBytes) {
  const bytes = await readRegularBytes(source, label, maximumBytes)
  await writeFile(target, bytes, { mode: 0o600, flag: 'wx' })
}

async function writeFailure(pathValue, failure) {
  await writeFile(pathValue, `${JSON.stringify(failure, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  })
}

function normalizedReward(value) {
  const reward = Number(value)
  if (!Number.isFinite(reward) || reward < 0 || reward > 1) {
    throw new ProtocolError('Harbor reward.txt 必须是 0 到 1 之间的数字')
  }
  return reward
}

async function readReward(logs) {
  const value = await readRegularText(join(logs, 'verifier', 'reward.txt'), 'Harbor reward.txt', MAXIMUM_REWARD_BYTES)
  if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/u.test(value)) {
    throw new ProtocolError('Harbor reward.txt 只能包含 0 到 1 之间的数字')
  }
  return normalizedReward(value)
}

async function readCtrf(logs) {
  const pathValue = join(logs, 'verifier', 'ctrf.json')
  const present = await lstat(pathValue).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (present === null) return null
  try {
    const source = await readRegularBytes(pathValue, 'Harbor CTRF 报告', MAXIMUM_CTRF_BYTES)
    const report = JSON.parse(source.toString('utf8'))
    if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('CTRF 必须是对象')
    const summary = summarizeCtrf(report, 'Harbor ctrf.json')
    if (summary.error) throw new ProtocolError(summary.error)
    // 只把受限的结构化摘要送进反馈和结果记录；原始 CTRF 留在 verifier 日志目录，
    // 避免把任意大小的测试输出直接喂给 Updater。
    return summary.summary
  } catch (error) {
    if (error instanceof ProtocolError) throw error
    throw new ProtocolError('Harbor CTRF 报告无效', [error.message])
  }
}

function harborRecord({ task, partition, reward, trials, feedbackLimit }) {
  const usageComplete = trials.every(
    (trial) => Number.isFinite(trial.inputTokens) && Number.isFinite(trial.outputTokens),
  )
  const record = {
    instance_id: task.name,
    status: reward === 1 ? 'resolved' : 'unresolved',
    reward,
    trial_rewards: trials.map((trial) => trial.reward),
    trial_seeds: trials.map((trial) => trial.seed),
    seed_controlled: false,
    ...(usageComplete
      ? {
          input_tokens: trials.reduce((sum, trial) => sum + trial.inputTokens, 0),
          output_tokens: trials.reduce((sum, trial) => sum + trial.outputTokens, 0),
        }
      : {}),
    latency_ms: trials.reduce((sum, trial) => sum + trial.durationMs, 0),
    policy_violations: [],
    solver_failures: trials.flatMap((trial) => trial.solverFailure ? [trial.solverFailure] : []),
    artifacts: trials.flatMap((trial) => trial.artifacts.map((artifact) => ({
      seed: trial.seed,
      root: relative(trial.runRoot, trial.root).replaceAll('\\', '/'),
      path: artifact,
    }))),
  }
  if (partition === 'feedback') {
    record.feedback = {
      taskInstruction: Buffer.from(task.instruction).subarray(0, feedbackLimit).toString('utf8').replace(/\ufffd$/u, ''),
      verifierReward: reward,
      ctrf: trials.map((trial) => trial.ctrf).filter(Boolean).join('\n\n') || null,
      errors: trials.filter((trial) => trial.solverFailure).map((trial) => (
        `${trial.solverFailure.category}: ${trial.solverFailure.code}`
      )),
    }
  }
  return record
}

function failure({ category, code, candidateId, partition, task, seed, terminal, process = null }) {
  return {
    protocol: SOLVER_FAILURE_PROTOCOL,
    category,
    code,
    terminal,
    context: { candidateId, partition, instanceId: task.name, seed },
    process,
    diagnostics: null,
  }
}

function solverResources(task, dockerResources) {
  return {
    cpus: task.config.environment.cpus,
    memory: `${task.config.environment.memoryMb}m`,
    pids: dockerResources.pids,
    ...(task.config.environment.gpus > 0 ? { gpus: task.config.environment.gpus } : {}),
  }
}

async function prepareTaskWorkspace({ docker, image, workspace, containerWorkspace, name }) {
  const container = await docker.create({ image, name })
  try {
    const owner = typeof process.getuid === 'function' && typeof process.getgid === 'function'
      ? `${process.getuid()}:${process.getgid()}`
      : null
    await docker.copyFrom(container.id, `${containerWorkspace}/.`, workspace, { owner })
  } finally {
    await docker.removeContainer(container.id).catch(() => {})
  }
}

export class HarborEnvironment {
  constructor({ environment, benchmark, solverDriver, docker, runRoot, repositoryRoot, allowGpu = false }) {
    this.environment = environment
    this.benchmark = benchmark
    this.solverDriver = solverDriver
    this.docker = docker
    this.runRoot = runRoot
    this.repositoryRoot = repositoryRoot
    this.allowGpu = allowGpu
    this.tasks = new Map()
    this.sourceRevision = null
    this.runtimeByTask = new Map()
    this.runtimeRevision = null
    this.runtimeIdentity = null
  }

  describeCapabilities() {
    return Object.freeze({
      apiVersion: 'harness-rsi/v1alpha1',
      environment: this.environment.id,
      partitions: PARTITIONS,
      supportsFeedback: true,
      supportsHiddenFinal: true,
      supportsTaskRetry: true,
      supportsCheckpointResume: true,
      scoreType: 'scalar',
      artifactType: 'harbor-declared-artifacts',
    })
  }

  async preflight() {
    const tasksRoot = resolveInside(this.repositoryRoot, this.environment.source.tasksRoot, 'Harbor Tasks 根目录')
    const loaded = new Map()
    for (const instanceId of this.benchmark.allInstanceIds) {
      const task = await loadHarborTask(tasksRoot, instanceId, {
        workspacePath: this.environment.task.workspacePath,
        allowGpu: this.allowGpu,
      })
      const hostResources = this.environment.docker?.resources ?? {}
      if (Number.isFinite(hostResources.cpus) && task.config.environment.cpus > hostResources.cpus) {
        throw new ProtocolError(`Harbor Task ${instanceId} 的 CPU 预算超过 Environment 上限`)
      }
      if (Number.isFinite(hostResources.memoryMb) && task.config.environment.memoryMb > hostResources.memoryMb) {
        throw new ProtocolError(`Harbor Task ${instanceId} 的内存预算超过 Environment 上限`)
      }
      if (Number.isFinite(hostResources.gpus) && task.config.environment.gpus > hostResources.gpus) {
        throw new ProtocolError(`Harbor Task ${instanceId} 的 GPU 预算超过 Environment 上限`)
      }
      loaded.set(instanceId, task)
    }
    const source = [...loaded.entries()].sort(([left], [right]) => left.localeCompare(right))
      .map(([id, task]) => `${id}:${task.digest}`).join('\n')
    const digest = sha256(source)
    if (digest !== this.environment.source.revision || digest !== this.benchmark.source.revision) {
      throw new ProtocolError('Harbor Tasks 摘要与冻结 Benchmark 不一致', [
        `actual=${digest}`,
        `environment=${this.environment.source.revision}`,
        `benchmark=${this.benchmark.source.revision}`,
      ])
    }
    await this.docker.info()
    this.tasks = loaded
    this.sourceRevision = digest
    this.runtimeByTask.clear()
    this.runtimeRevision = null
    this.runtimeIdentity = null
    return { sourceRoot: tasksRoot, sourceRevision: digest }
  }

  async taskLayout(instanceId) {
    const task = this.tasks.get(safeSegment(instanceId, 'Harbor Task ID'))
    if (!task) throw new ProtocolError(`Harbor Task 不存在：${instanceId}`)
    return Object.freeze({
      instanceId: task.name,
      partition: this.benchmark.partitionByInstance.get(task.name),
      instruction: task.instruction,
      harborDigest: task.digest,
      artifacts: task.config.artifacts,
    })
  }

  async ensureRuntime(task = null) {
    if (task === null || task === undefined) {
      if (!this.tasks.size) throw new ProtocolError('必须先执行 Harbor Environment preflight')
      const runtimes = new Map()
      for (const current of this.tasks.values()) {
        runtimes.set(current.name, await this.ensureRuntime(current))
      }
      return runtimes
    }
    const cached = this.runtimeByTask.get(task.name)
    if (cached) return cached
    const tag = safeDockerName(
      `${this.environment.runtime.imagePrefix}-${task.name}-${task.digest.slice(0, 12)}`,
    )
    const buildKey = `${tag}:${task.digest}`
    if (!RUNTIME_BUILDS.has(buildKey)) {
      const build = this.docker.build({
        // 只把 Harbor 的 environment/ 构建上下文交给 Solver 镜像；
        // 如果把整个任务根目录作为 context，tests/ 可能被打进镜像并泄露给 Candidate。
        context: dirname(task.environmentDockerfile),
        dockerfile: task.environmentDockerfile,
        tag,
        timeoutMs: task.config.environment.buildTimeoutSeconds * 1000,
      }).finally(() => RUNTIME_BUILDS.delete(buildKey))
      RUNTIME_BUILDS.set(buildKey, build)
    }
    await RUNTIME_BUILDS.get(buildKey)
    const identity = await this.docker.imageId(tag)
    const solverTag = safeDockerName(`${tag}-${this.solverDriver.cacheKey ?? 'solver'}`)
    const solverKey = `${solverTag}:${identity}`
    if (!RUNTIME_BUILDS.has(solverKey)) {
      const build = this.solverDriver.ensureRuntime({
        baseImage: tag,
        baseImageIdentity: identity,
        tag: solverTag,
      }).finally(() => RUNTIME_BUILDS.delete(solverKey))
      RUNTIME_BUILDS.set(solverKey, build)
    }
    const runtime = await RUNTIME_BUILDS.get(solverKey)
    const result = Object.freeze({
      baseImage: tag,
      solverImage: runtime.image,
      solverImageIdentity: runtime.imageIdentity ?? runtime.identity ?? null,
    })
    this.runtimeByTask.set(task.name, result)
    const runtimeEntries = [...this.runtimeByTask.entries()].sort(([left], [right]) => left.localeCompare(right))
    this.runtimeRevision = sha256(JSON.stringify(runtimeEntries))
    this.runtimeIdentity = Object.freeze({
      protocol: this.environment.protocol,
      sourceRevision: this.sourceRevision,
      tasks: runtimeEntries.map(([name, value]) => ({ name, ...value })),
    })
    return result
  }

  async runVerifier({ task, submission, logs, name }) {
    const verifierImage = safeDockerName(`harbor-verifier-${task.name}-${task.digest.slice(0, 12)}`)
    const buildKey = `${verifierImage}:${task.digest}`
    if (!RUNTIME_BUILDS.has(buildKey)) {
      RUNTIME_BUILDS.set(buildKey, this.docker.build({
        context: task.verifierRoot,
        dockerfile: task.verifierDockerfile,
        tag: verifierImage,
        timeoutMs: task.config.environment.buildTimeoutSeconds * 1000,
      }).finally(() => RUNTIME_BUILDS.delete(buildKey)))
    }
    await RUNTIME_BUILDS.get(buildKey)
    const verifierLogs = join(logs, 'verifier')
    await mkdir(verifierLogs, { recursive: true, mode: 0o700 })
    await this.docker.run({
      image: verifierImage,
      name,
      command: ['/bin/bash', '/tests/test.sh'],
      mounts: [
        { source: submission, target: this.environment.task.workspacePath, readOnly: true },
        { source: verifierLogs, target: '/logs/verifier', readOnly: false },
      ],
      // GPU/科学计算镜像通常把 Python 放在 /opt/conda/bin；显式 PATH 不能
      // 把它截掉，否则 verifier 会在真正执行测试前直接报 python not found。
      environment: {
        HOME: '/tmp/home',
        TMPDIR: '/tmp',
        PATH: '/opt/conda/bin:/usr/local/bin:/usr/bin:/bin',
      },
      inheritEnvironment: [],
      network: 'none',
      readOnlyRoot: true,
      capabilities: [],
      resources: {
        ...this.environment.verifier.resources,
        ...(task.config.environment.gpus > 0 ? { gpus: task.config.environment.gpus } : {}),
      },
      timeoutMs: task.config.verifier.timeoutSeconds * 1000,
    })
    return { reward: await readReward(logs), ctrf: await readCtrf(logs) }
  }

  async runTrial({ candidateId, candidateDigest, candidateWorkspace, model, partition, task, seed, trialIndex, executionId }) {
    const root = join(this.runRoot, 'trials', executionId, safeSegment(candidateId, 'Candidate ID'), partition, task.name, `trial-${trialIndex + 1}-seed-${seed}`)
    assertInside(this.runRoot, root, 'Harbor Trial')
    const workspace = join(root, 'workspace')
    const assets = join(root, 'environment-assets')
    const output = join(root, 'solver-output')
    const submission = join(root, 'submission')
    const logs = join(root, 'logs')
    await rm(root, { recursive: true, force: true })
    await Promise.all([workspace, assets, output, submission, logs].map((pathValue) => mkdir(pathValue, { recursive: true, mode: 0o700 })))
    const startedAt = Date.now()
    const runtime = await this.ensureRuntime(task)
    await prepareTaskWorkspace({
      docker: this.docker,
      image: runtime.baseImage,
      workspace,
      containerWorkspace: this.environment.task.workspacePath,
      name: `${executionId}-${candidateId}-${task.name}-${seed}-seed-copy`,
    })
    await inspectWorkspaceTree(
      workspace,
      task.config.environment.storageMb * 1024 * 1024,
      'Harbor Task Workspace',
    )
    const resources = solverResources(task, this.environment.docker.resources)
    let solver = null
    let solverFailure = null
    try {
      solver = await withGlobalPermit('solver', () => this.solverDriver.run({
        image: runtime.solverImage,
        model,
        candidateWorkspace,
        taskWorkspace: workspace,
        environmentAssets: assets,
        sessionRoot: join(root, 'solver-session'),
        task: task.instruction,
        name: `${executionId}-${candidateId}-${task.name}-${seed}-solver`,
        timeoutMs: task.config.agent.timeoutSeconds * 1000,
        containerWorkspace: this.environment.task.workspacePath,
        solverOutput: output,
        resources,
      }))
    } catch (cause) {
      if (!(cause instanceof SolverFailure)) throw new ProtocolError('Harbor Solver 基础设施失败', [
        cause?.message ?? String(cause),
        ...(cause?.details ?? []),
        `candidate=${candidateId}`,
        `task=${task.name}`,
        `seed=${seed}`,
      ])
      if (!cause.failure.terminal || this.environment.solverFailurePolicy === 'pause') throw cause
      solverFailure = cause.failure
      solver = { modelUsage: cause.modelUsage }
      await writeFailure(join(root, 'solver-failure.json'), solverFailure)
    }

    let artifacts = []
    if (!solverFailure) {
      try {
        await inspectWorkspaceTree(
          workspace,
          task.config.environment.storageMb * 1024 * 1024,
          'Harbor Task Workspace',
        )
        for (const artifact of task.config.artifacts) {
          const suffix = artifact.slice(this.environment.task.workspacePath.length).replace(/^\//u, '')
          const source = resolve(workspace, suffix)
          const target = resolve(submission, suffix)
          assertInside(workspace, source, 'Harbor Artifact Source')
          assertInside(submission, target, 'Harbor Submission')
          await assertNoSymlinkAncestors(source, workspace, 'Harbor Artifact Source')
          await mkdir(dirname(target), { recursive: true, mode: 0o700 })
          await assertNoSymlinkAncestors(target, submission, 'Harbor Submission')
          await copyRegularFile(source, target, `Harbor Artifact：${artifact}`, 64 * 1024 * 1024)
          artifacts.push(artifact)
        }
      } catch (cause) {
        // 未完成交付物集合不能写成已交付，否则终态零分 Checkpoint 自身会校验失败。
        artifacts = []
        solverFailure = failure({
          category: 'candidate',
          code: 'missing-or-unsafe-declared-artifact',
          candidateId,
          partition,
          task,
          seed,
          terminal: true,
        })
        await writeFailure(join(root, 'solver-failure.json'), solverFailure)
      }
    }

    if (solverFailure) {
      return {
        reward: 0,
        ctrf: null,
        durationMs: Date.now() - startedAt,
        inputTokens: solver.modelUsage?.complete ? solver.modelUsage.inputTokens : null,
        outputTokens: solver.modelUsage?.complete ? solver.modelUsage.outputTokens : null,
        root,
        runRoot: this.runRoot,
        seed,
        artifacts,
        solverFailure,
      }
    }

    let verified
    try {
      verified = await this.runVerifier({
        task,
        submission,
        logs,
        name: `${executionId}-${candidateId}-${task.name}-${seed}-verifier`,
      })
    } catch (cause) {
      const verifierFailure = failure({
        category: 'trusted-runtime',
        code: 'verifier-infrastructure',
        candidateId,
        partition,
        task,
        seed,
        terminal: false,
      })
      await writeFailure(join(root, 'verifier-failure.json'), verifierFailure)
      throw new SolverFailure(verifierFailure, { modelUsage: solver.modelUsage })
    }
    return {
      reward: verified.reward,
      ctrf: verified.ctrf,
      durationMs: Date.now() - startedAt,
      inputTokens: solver.modelUsage?.complete ? solver.modelUsage.inputTokens : null,
      outputTokens: solver.modelUsage?.complete ? solver.modelUsage.outputTokens : null,
      root,
      runRoot: this.runRoot,
      seed,
      artifacts,
      solverFailure: null,
    }
  }

  async runCandidatePartition({
    candidateId,
    candidateDigest,
    candidateWorkspace,
    model,
    partition,
    seeds,
    outputPath,
    infrastructureRetries = 0,
    retryReasoningOnly = false,
    strictFinalCheckpoints = false,
    maximumConcurrentTrials = this.environment.task.maximumConcurrentTrials ?? 1,
    onInfrastructureRetry = () => {},
  }) {
    validateInfrastructureRetries(infrastructureRetries)
    if (!Number.isSafeInteger(maximumConcurrentTrials)
        || maximumConcurrentTrials < 1
        || maximumConcurrentTrials > (this.environment.task.maximumConcurrentTrials ?? 1)) {
      throw new ProtocolError('Harbor 评测并发只能降低，不能超过冻结 Environment 上限')
    }
    if (typeof retryReasoningOnly !== 'boolean' || typeof strictFinalCheckpoints !== 'boolean') {
      throw new ProtocolError('Harbor Final 重试兼容选项必须是布尔值')
    }
    if ((retryReasoningOnly || strictFinalCheckpoints) && partition !== 'final') {
      throw new ProtocolError('Harbor Final 重试兼容选项不能用于训练题')
    }
    if (!this.tasks.size) throw new ProtocolError('必须先执行 Harbor Environment preflight')
    const partitionSpec = this.benchmark.partitions[partition]
    if (!PARTITIONS.includes(partition) || !partitionSpec) {
      throw new ProtocolError(`Harbor 不支持 Partition：${partition}`)
    }
    safeSegment(candidateId, 'Candidate ID')
    if (typeof candidateDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(candidateDigest)) {
      throw new ProtocolError(`Candidate ${candidateId} 缺少可用于 Trial Checkpoint 的完整 Digest`)
    }
    const candidate = await realpath(resolve(candidateWorkspace)).catch((error) => {
      throw new ProtocolError(`Candidate Workspace 不存在：${candidateWorkspace}`, [error.message])
    })
    const output = resolve(outputPath)
    assertInside(this.runRoot, output, 'Harbor 结果文件')
    await mkdir(dirname(output), { recursive: true, mode: 0o700 })
    await assertNoSymlinkAncestors(output, this.runRoot, 'Harbor 结果文件')
    const outputInfo = await lstat(output).catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (outputInfo && (outputInfo.isSymbolicLink() || !outputInfo.isFile() || outputInfo.nlink !== 1)) {
      throw new ProtocolError('Harbor 结果文件必须是普通文件或尚不存在')
    }
    if (!Array.isArray(seeds) || seeds.length === 0
        || new Set(seeds).size !== seeds.length
        || seeds.some((seed) => !Number.isInteger(seed) || seed < 0)) {
      throw new ProtocolError('Harbor seeds 必须是非空、唯一、非负整数数组')
    }
    const executionId = sha256(output).slice(0, 12)
    const instanceIds = [...partitionSpec.instanceIds]
    const mapWithConcurrency = async (values, operation) => {
      const results = new Array(values.length)
      const failures = []
      let cursor = 0
      async function worker() {
        while (cursor < values.length) {
          const index = cursor
          cursor += 1
          try {
            results[index] = await operation(values[index], index)
          } catch (error) {
            failures.push({ index, error })
          }
        }
      }
      await Promise.all(Array.from(
        { length: Math.min(maximumConcurrentTrials, values.length) },
        () => worker(),
      ))
      if (failures.length > 0) {
        failures.sort((left, right) => left.index - right.index)
        const first = failures[0].error
        if (failures.length > 1) {
          first.details = [...(first.details ?? []), `同批共 ${failures.length} 个 Harbor Trial 失败`]
        }
        throw first
      }
      return results
    }

    const plans = await mapWithConcurrency(instanceIds, async (instanceId) => {
      const task = this.tasks.get(instanceId)
      if (!task) throw new ProtocolError(`Harbor Task 不存在：${instanceId}`)
      const taskRoot = join(this.runRoot, 'trials', executionId, safeSegment(candidateId, 'Candidate ID'), partition, task.name)
      assertInside(this.runRoot, taskRoot, 'Harbor Task Trial')
      const identity = {
        executionId,
        ...(infrastructureRetries > 0 ? { infrastructureRetries } : {}),
        ...(retryReasoningOnly ? { retryReasoningOnly: true } : {}),
        ...(strictFinalCheckpoints ? { strictFinalCheckpoints: true } : {}),
        environment: {
          id: this.environment.id,
          protocol: this.environment.protocol,
          sourceRevision: this.sourceRevision,
          solverFailureProtocol: SOLVER_FAILURE_PROTOCOL,
          solverFailurePolicy: this.environment.solverFailurePolicy ?? 'verified-candidate-terminal-v1',
        },
        solver: { id: this.solverDriver.id ?? null, cacheKey: this.solverDriver.cacheKey ?? null },
        candidate: { id: candidateId, digest: candidateDigest },
        partition,
        instanceId,
        seeds: [...seeds],
        model: {
          provider: model?.provider ?? null,
          model: model?.model ?? null,
          maxTokens: model?.maxTokens ?? null,
          reasoningEffort: model?.reasoningEffort ?? null,
        },
      }
      const validateCheckpointRecord = async (record) => {
        const normalized = validateResultRecords(
          [record],
          this.benchmark,
          `${candidateId}/${partition}/${instanceId}/checkpoint`,
        )
        if (!normalized.has(instanceId) || record.instance_id !== instanceId
            || JSON.stringify(record.trial_seeds) !== JSON.stringify(seeds)) {
          throw new ProtocolError(`Harbor Trial Checkpoint 与 Task/Seed 不一致：${instanceId}`)
        }
        const failures = Array.isArray(record.solver_failures) ? record.solver_failures : []
        if (failures.length > 0 && failures.some((item) => item.category !== 'candidate' || item.terminal !== true)) {
          throw new ProtocolError(`Harbor Trial Checkpoint 含有不可提交的 Solver 故障：${instanceId}`)
        }
        const artifacts = Array.isArray(record.artifacts) ? record.artifacts : []
        const failedSeeds = new Set(failures.map((item) => item.context?.seed).filter((seed) => seeds.includes(seed)))
        const expectedCount = (seeds.length - failedSeeds.size) * task.config.artifacts.length
        if (artifacts.length !== expectedCount) {
          throw new ProtocolError(`Harbor Trial Checkpoint Artifact 数量无效：${instanceId}`)
        }
        for (const artifact of artifacts) {
          if (!seeds.includes(artifact.seed) || !task.config.artifacts.includes(artifact.path)) {
            throw new ProtocolError(`Harbor Trial Checkpoint Artifact 身份无效：${instanceId}`)
          }
          const trialIndex = seeds.indexOf(artifact.seed)
          const expectedRoot = join(taskRoot, `trial-${trialIndex + 1}-seed-${artifact.seed}`)
          const expectedRelative = relative(this.runRoot, expectedRoot).replaceAll('\\', '/')
          if (artifact.root !== expectedRelative) {
            throw new ProtocolError(`Harbor Trial Checkpoint Artifact Root 无效：${instanceId}/${artifact.seed}`)
          }
          const artifactRoot = await lstat(expectedRoot).catch((error) => {
            throw new ProtocolError(`Harbor Trial Checkpoint Artifact Root 不存在：${instanceId}/${artifact.seed}`, [error.message])
          })
          if (artifactRoot.isSymbolicLink() || !artifactRoot.isDirectory()) {
            throw new ProtocolError(`Harbor Trial Checkpoint Artifact Root 必须是普通目录：${instanceId}/${artifact.seed}`)
          }
        }
        return record
      }
      const checkpoint = await inspectTrialCheckpoint({
        runRoot: this.runRoot,
        taskRoot,
        identity,
        validateRecord: validateCheckpointRecord,
      })
      if (strictFinalCheckpoints && checkpoint.status === 'stale') {
        throw new ProtocolError('Harbor Final 已提交题目的身份发生变化，禁止覆盖重测')
      }
      return { task, taskRoot, identity, validateCheckpointRecord, checkpoint }
    })
    const pending = plans.filter(({ checkpoint }) => checkpoint.status !== 'committed')
    const freshRecords = new Map()
    let runError
    if (pending.length > 0) {
      await this.solverDriver.beginUsageBatch?.()
      try {
        await mapWithConcurrency(pending, async ({ task, taskRoot, identity, validateCheckpointRecord, checkpoint }) => {
          if (checkpoint.status !== 'missing') {
            await quarantineTrialTask({
              runRoot: this.runRoot,
              taskRoot,
              reason: checkpoint.status === 'stale' ? 'checkpoint-identity-changed' : 'task-attempt-incomplete',
            })
          }
          const trials = await withTrialInfrastructureRetries(async () => {
            if (strictFinalCheckpoints) {
              await reserveFinalTrialAttempt(
                join(this.runRoot, 'final-retry-budgets', executionId, safeSegment(candidateId, 'Candidate ID'), `${task.name}.json`),
                identity,
                infrastructureRetries + 1,
              )
            }
            const attempts = []
            for (const [trialIndex, seed] of seeds.entries()) {
              attempts.push(await this.runTrial({
                candidateId,
                candidateDigest,
                candidateWorkspace: candidate,
                model,
                partition,
                task,
                seed,
                trialIndex,
                executionId,
              }))
            }
            return attempts
          }, {
            maximumRetries: infrastructureRetries,
            retryReasoningOnly,
            beforeRetry: async ({ error, retry, maximumRetries, delayMs }) => {
              await quarantineTrialTask({
                runRoot: this.runRoot,
                taskRoot,
                reason: { kind: 'harbor-infrastructure-retry', code: error.failure?.code ?? error.code, retry, maximumRetries, delayMs },
              })
              await onInfrastructureRetry({ retry, maximumRetries, delayMs })
            },
          })
          const record = harborRecord({
            task,
            partition,
            reward: trials.reduce((sum, trial) => sum + trial.reward, 0) / trials.length,
            trials,
            feedbackLimit: this.environment.feedback.maximumTextBytesPerCase,
          })
          await validateCheckpointRecord(record)
          await commitTrialCheckpoint({ runRoot: this.runRoot, taskRoot, identity, record })
          freshRecords.set(task.name, record)
        })
      } catch (error) {
        runError = error
      }
      try {
        await this.solverDriver.endUsageBatch?.()
      } catch (error) {
        if (!runError) throw error
        runError.details = [...(runError.details ?? []), `Solver Usage Batch 收尾失败：${error.message}`]
      }
    }
    if (runError) throw runError
    const records = plans.map(({ task, checkpoint }) => (
      checkpoint.status === 'committed' ? checkpoint.record : freshRecords.get(task.name)
    ))
    if (records.some((record) => record === undefined)) {
      throw new ProtocolError(`${candidateId}/${partition} Harbor Trial Checkpoint 合并不完整`)
    }
    await writeJsonLines(output, records)
    return validateResultRecords(records, this.benchmark, `${candidateId}/${partition}`)
  }
}
