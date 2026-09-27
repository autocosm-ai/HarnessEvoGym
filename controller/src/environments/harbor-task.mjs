import { createHash } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { parse as parseToml } from 'smol-toml'

import { ProtocolError } from '../protocol.mjs'
import { resolveInside } from '../config.mjs'

const MAXIMUM_TASK_FILE_BYTES = 2 * 1024 * 1024
const MAXIMUM_INSTRUCTION_BYTES = 256 * 1024
const MAXIMUM_ARTIFACTS = 128
const HARBOR_SCHEMA_VERSION = '1.0'

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError(`${label} 必须是对象`)
  }
  return value
}

function rejectUnknown(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length > 0) throw new ProtocolError(`${label} 含有未知字段`, unknown)
}

function text(value, label, maximumBytes = 4096) {
  if (typeof value !== 'string' || value.trim().length === 0 || /\u0000/u.test(value)) {
    throw new ProtocolError(`${label} 必须是非空字符串`)
  }
  if (Buffer.byteLength(value, 'utf8') > maximumBytes) {
    throw new ProtocolError(`${label} 超过 ${maximumBytes} 字节上限`)
  }
  return value.trim()
}

function artifactPath(value, label, workspacePath) {
  const path = text(value, label, 1024)
  if (!path.startsWith('/') || path.includes('\\') || /[\u0000-\u001f,]/u.test(path) || path.split('/').slice(1).some((part) => !part || part === '.' || part === '..')) {
    throw new ProtocolError(`${label} 必须是安全绝对路径`)
  }
  const workspace = workspacePath.replace(/\/$/u, '')
  if (!path.startsWith(`${workspace}/`)) {
    throw new ProtocolError(`${label} 必须位于 Harbor agent 工作区 ${workspace} 内`)
  }
  return path
}

async function regularFile(pathValue, label, maximumBytes) {
  const info = await lstat(pathValue).catch((error) => {
    throw new ProtocolError(`${label} 不存在`, [error.message])
  })
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
    throw new ProtocolError(`${label} 必须是独立普通文件`)
  }
  if (info.size < 1 || info.size > maximumBytes) {
    throw new ProtocolError(`${label} 文件大小无效`, [`bytes=${info.size}`, `maximum=${maximumBytes}`])
  }
  return info
}

async function assertDirectoryChain(pathValue) {
  const absolute = resolve(pathValue)
  let current = '/'
  for (const segment of absolute.split('/').filter(Boolean)) {
    current = join(current, segment)
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new ProtocolError(`Harbor 目录不能包含符号链接：${current}`)
    }
  }
}

// 覆盖整个任务树，包括 Docker 构建输入和 verifier 辅助文件。
async function digestTree(root) {
  const hash = createHash('sha256')
  let count = 0
  let totalBytes = 0
  async function visit(directory) {
    const entries = await readdir(directory)
    entries.sort()
    for (const name of entries) {
      if (++count > 10000) throw new ProtocolError('Harbor Task 文件数量超限')
      const absolute = join(directory, name)
      const path = relative(root, absolute).replaceAll('\\', '/')
      const info = await lstat(absolute)
      if (info.isSymbolicLink()) throw new ProtocolError(`Harbor Task 禁止符号链接：${path}`)
      if (info.isDirectory()) {
        hash.update('directory\0').update(path).update('\0')
        await visit(absolute)
      } else {
        if (!info.isFile() || info.nlink !== 1 || info.size > MAXIMUM_TASK_FILE_BYTES) {
          throw new ProtocolError(`Harbor Task 必须是大小受限的独立普通文件：${path}`)
        }
        totalBytes += info.size
        if (totalBytes > 64 * 1024 * 1024) throw new ProtocolError('Harbor Task 总大小超限')
        hash.update('file\0').update(path).update('\0').update(String(info.mode & 0o777)).update('\0')
          .update(await readFile(absolute)).update('\0')
      }
    }
  }
  await visit(root)
  return hash.digest('hex')
}

function resourceNumber(value, label, fallback, maximum, integer = true, minimum = 1) {
  const result = value ?? fallback
  if (typeof result !== 'number' || !Number.isFinite(result) || result < minimum || result > maximum || (integer && !Number.isInteger(result))) {
    throw new ProtocolError(`${label} 资源限制无效`)
  }
  return result
}

function validateTimeout(value, label, fallback = 120) {
  const timeout = value ?? fallback
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout < 1 || timeout > 7200) {
    throw new ProtocolError(`${label} 必须位于 1 到 7200 秒之间`)
  }
  return timeout
}

export function validateHarborTaskToml(input, taskRoot, { workspacePath = '/app' } = {}) {
  const document = object(input, 'Harbor task.toml')
  rejectUnknown(document, new Set(['schema_version', 'artifacts', 'metadata', 'verifier', 'agent', 'environment']), 'Harbor task.toml')
  if (document.schema_version !== HARBOR_SCHEMA_VERSION) {
    throw new ProtocolError(`Harbor task.toml schema_version 必须是 ${HARBOR_SCHEMA_VERSION}`)
  }
  if (!Array.isArray(document.artifacts) || document.artifacts.length < 1 || document.artifacts.length > MAXIMUM_ARTIFACTS) {
    throw new ProtocolError('Harbor task.toml artifacts 必须是非空数组')
  }
  const artifacts = document.artifacts.map((value, index) => artifactPath(value, `Harbor artifacts[${index}]`, workspacePath))
  if (new Set(artifacts).size !== artifacts.length) throw new ProtocolError('Harbor artifacts 不能重复')

  const metadata = object(document.metadata, 'Harbor task.toml.metadata')
  const verifier = object(document.verifier, 'Harbor task.toml.verifier')
  const agent = object(document.agent, 'Harbor task.toml.agent')
  const environment = object(document.environment, 'Harbor task.toml.environment')
  rejectUnknown(metadata, new Set(['category', 'tags']), 'Harbor task.toml.metadata')
  rejectUnknown(verifier, new Set(['environment_mode', 'timeout_sec']), 'Harbor task.toml.verifier')
  rejectUnknown(agent, new Set(['timeout_sec']), 'Harbor task.toml.agent')
  rejectUnknown(environment, new Set(['build_timeout_sec', 'cpus', 'memory_mb', 'storage_mb', 'gpus', 'allow_internet']), 'Harbor task.toml.environment')
  if (metadata.category !== undefined && typeof metadata.category !== 'string') {
    throw new ProtocolError('Harbor metadata.category 必须是字符串')
  }
  if (metadata.tags !== undefined && !Array.isArray(metadata.tags)) {
    throw new ProtocolError('Harbor metadata.tags 必须是字符串数组')
  }
  const environmentMode = verifier.environment_mode
  if (environmentMode !== 'separate') {
    throw new ProtocolError('Harbor Environment Adapter 只允许 verifier.environment_mode=separate')
  }
  if (environment.gpus !== undefined
      && (!Number.isInteger(environment.gpus) || environment.gpus < 0)) {
    throw new ProtocolError('Harbor environment.gpus 必须是非负整数')
  }
  if ((environment.gpus ?? 0) !== 0) throw new ProtocolError('Harbor Adapter 暂不支持 GPU')
  if (environment.allow_internet !== undefined && typeof environment.allow_internet !== 'boolean') {
    throw new ProtocolError('Harbor environment.allow_internet 必须是布尔值')
  }
  if (environment.allow_internet === true) {
    throw new ProtocolError('Harbor Adapter 当前只支持 allow_internet=false；Solver 必须连接受控 Model Gateway 网络')
  }
  const taskName = taskRoot ? taskRoot.split('/').pop() : 'task'
  return Object.freeze({
    schemaVersion: document.schema_version,
    taskName,
    artifacts: Object.freeze(artifacts),
    metadata: Object.freeze({
      category: typeof metadata.category === 'string' ? metadata.category : null,
      tags: Array.isArray(metadata.tags)
        ? metadata.tags.map((tag, index) => text(tag, `Harbor metadata.tags[${index}]`, 256))
        : [],
    }),
    verifier: Object.freeze({
      environmentMode,
      timeoutSeconds: validateTimeout(verifier.timeout_sec, 'Harbor verifier.timeout_sec'),
    }),
    agent: Object.freeze({
      timeoutSeconds: validateTimeout(agent.timeout_sec, 'Harbor agent.timeout_sec'),
    }),
    environment: Object.freeze({
      buildTimeoutSeconds: validateTimeout(environment.build_timeout_sec, 'Harbor environment.build_timeout_sec', 600),
      cpus: resourceNumber(environment.cpus, 'Harbor environment.cpus', 1, 64, false, 0.1),
      memoryMb: resourceNumber(environment.memory_mb, 'Harbor environment.memory_mb', 2048, 262144),
      storageMb: resourceNumber(environment.storage_mb, 'Harbor environment.storage_mb', 10240, 1048576),
      gpus: environment.gpus ?? 0,
      // 当前 Solver 必须连接 Run 专属 Model Gateway，不能同时接入外部网络。
      // 未声明时按最小权限处理；显式 true 由执行器拒绝，避免静默忽略配置。
      allowInternet: environment.allow_internet ?? false,
    }),
  })
}

export async function loadHarborTask(tasksRoot, taskName, options = {}) {
  const safeName = text(taskName, 'Harbor Task 名称', 128)
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(safeName)) {
    throw new ProtocolError(`Harbor Task 名称无效：${safeName}`)
  }
  const root = resolveInside(tasksRoot, safeName, 'Harbor Task 根目录')
  await assertDirectoryChain(root)
  const taskToml = relative(root, join(root, 'task.toml')).replaceAll('\\', '/')
  const instructionPath = resolveInside(root, 'instruction.md', 'Harbor instruction.md')
  const environmentDockerfile = resolveInside(root, 'environment/Dockerfile', 'Harbor environment Dockerfile')
  const verifierDockerfile = resolveInside(root, 'tests/Dockerfile', 'Harbor tests Dockerfile')
  const testScript = resolveInside(root, 'tests/test.sh', 'Harbor tests/test.sh')
  for (const [pathValue, label] of [
    [resolve(root, taskToml), 'Harbor task.toml'],
    [instructionPath, 'Harbor instruction.md'],
    [environmentDockerfile, 'Harbor environment/Dockerfile'],
    [verifierDockerfile, 'Harbor tests/Dockerfile'],
    [testScript, 'Harbor tests/test.sh'],
  ]) await regularFile(pathValue, label, MAXIMUM_TASK_FILE_BYTES)

  let document
  try {
    document = parseToml(await readFile(resolve(root, taskToml), 'utf8'))
  } catch (error) {
    throw new ProtocolError(`Harbor task.toml 解析失败：${safeName}`, [error.message])
  }
  const config = validateHarborTaskToml(document, root, options)
  const instruction = await readFile(instructionPath, 'utf8')
  if (Buffer.byteLength(instruction, 'utf8') > MAXIMUM_INSTRUCTION_BYTES) {
    throw new ProtocolError(`Harbor instruction.md 超过 ${MAXIMUM_INSTRUCTION_BYTES} 字节`)
  }
  const digest = await digestTree(root)
  return Object.freeze({
    name: safeName,
    root,
    instruction: text(instruction, 'Harbor instruction.md', MAXIMUM_INSTRUCTION_BYTES),
    environmentDockerfile,
    verifierRoot: resolve(root, 'tests'),
    verifierDockerfile,
    testScript,
    digest,
    config,
  })
}

export const HARBOR_TASK_SCHEMA_VERSION = HARBOR_SCHEMA_VERSION
