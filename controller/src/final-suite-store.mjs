import { randomUUID } from 'node:crypto'
import { chmod, link, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ProtocolError } from './protocol.mjs'
import { trialCheckpointDigest } from './trial-checkpoint-store.mjs'

export const digest = trialCheckpointDigest

export async function readOptionalJson(path) {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) {
      throw new ProtocolError('Final Suite 记录必须是大小受限的普通文件')
    }
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

export async function saveSuiteJson(path, value, { immutable = false } = {}) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${randomUUID()}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  try {
    if (immutable) {
      try { await link(temporary, path) } catch (error) {
        if (error.code !== 'EEXIST') throw error
        if (digest(await readOptionalJson(path)) !== digest(value)) {
          throw new ProtocolError('Final Suite 不可变记录已存在且内容不同')
        }
      }
      await chmod(path, 0o400)
    } else await rename(temporary, path)
  } finally { await unlink(temporary).catch(() => {}) }
}

// 重试预算放在题目工作区之外，归档半成品和跨进程 Resume 都不会清零。
export async function reserveFinalTrialAttempt(path, identity, maximumAttempts) {
  const existing = await readOptionalJson(path)
  const identityDigest = digest(identity)
  if (existing && (existing.identityDigest !== identityDigest
      || existing.maximumAttempts !== maximumAttempts
      || !Number.isSafeInteger(existing.started) || existing.started < 1)) {
    throw new ProtocolError('Final 题目持久化重试预算身份不一致')
  }
  const started = existing?.started ?? 0
  if (started >= maximumAttempts) throw new ProtocolError('Final 题目重试预算已耗尽，禁止 Resume 增加采样次数')
  await saveSuiteJson(path, { identityDigest, maximumAttempts, started: started + 1 })
}
