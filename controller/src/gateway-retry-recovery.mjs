import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertExecutionIdentity, ResumeCompatibilityError } from './execution-identity.mjs'

// 仅允许仓库中逐文件固定摘要的重试补丁；不能作为任意执行漂移的豁免。
export async function loadGatewayRetryPatch(repositoryRoot) {
  return JSON.parse(await readFile(join(repositoryRoot, 'recovery/gateway-retry-v1.json'), 'utf8'))
}

export function assertGatewayRetryRecovery(stored, current, patch, retries) {
  if (!Number.isSafeInteger(retries) || retries < 0 || retries > 20) {
    throw new ResumeCompatibilityError('gateway-retries 必须是 0..20 的整数')
  }
  assertExecutionIdentity(stored, stored)
  assertExecutionIdentity(current, current)
  if (patch?.kind !== 'GatewayRetryCodePatch' || !Array.isArray(patch.changes)) {
    throw new ResumeCompatibilityError('缺少已核对的 Gateway 重试补丁清单')
  }
  const { files: before, ...oldRuntime } = stored.spec
  const { files: after, ...newRuntime } = current.spec
  if (JSON.stringify(oldRuntime) !== JSON.stringify(newRuntime)) {
    throw new ResumeCompatibilityError('重试恢复不能更换 Node、依赖或错误处理协议')
  }
  const previous = new Map(before.map(row => [row.path, row]))
  const next = new Map(after.map(row => [row.path, row]))
  const approved = new Map(patch.changes.map(row => [row.path, row]))
  for (const path of new Set([...previous.keys(), ...next.keys()])) {
    const old = previous.get(path) ?? null
    const now = next.get(path) ?? null
    if (JSON.stringify(old) === JSON.stringify(now)) continue
    const allowed = approved.get(path)
    if (!allowed || JSON.stringify(old) !== JSON.stringify(allowed.before)
        || JSON.stringify(now) !== JSON.stringify(allowed.after)) {
      throw new ResumeCompatibilityError('重试恢复发现补丁范围之外的执行改动', [path])
    }
  }
}

export function retryGatewayConfig(config, retries) {
  if (retries === null) return config
  if (!Number.isSafeInteger(retries) || retries < (config.maximumUpstreamRetries ?? 2) || retries > 20) {
    throw new ResumeCompatibilityError('重试恢复只能在 0..20 范围内增加原有重试次数')
  }
  // 镜像使用独立标签，避免覆盖其他仍在运行实验的 Gateway 镜像。
  return { ...config, maximumUpstreamRetries: retries,
    image: 'harness-rsi/model-gateway:retry-recovery-v1-' + retries }
}

export async function recordGatewayRetryRecovery(runRoot, receipt) {
  const path = join(runRoot, 'public', 'gateway-retry-recovery.json')
  const text = JSON.stringify(receipt, null, 2) + '\n'
  try { await writeFile(path, text, { flag: 'wx', mode: 0o444 }) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    if (await readFile(path, 'utf8') !== text) {
      throw new ResumeCompatibilityError('该 Run 已绑定不同的重试恢复记录')
    }
  }
}
