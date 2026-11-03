import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ProtocolError } from './protocol.mjs'
import { updaterSupervision } from './updater-watchdog.mjs'

export function updaterJournalPath(runRoot, candidateId) {
  if (!/^g\d+-l[123]$/u.test(candidateId)) throw new ProtocolError('Updater Candidate ID 无效')
  return join(runRoot, 'updater-attempts', candidateId, 'state.json')
}

export async function readUpdaterJournal(runRoot, candidateId) {
  const path = updaterJournalPath(runRoot, candidateId)
  const info = await lstat(path).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!info) return null
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new ProtocolError('Updater 重试记录不安全')
  const value = JSON.parse(await readFile(path, 'utf8'))
  if (value.kind !== 'UpdaterAttempts' || typeof value.identity !== 'string'
      || !Array.isArray(value.attempts) || value.attempts.length < 1 || value.attempts.length > 6
      || value.attempts.some((attempt, index) => !attempt || attempt.attempt !== index + 1
        || !['running', 'interrupted', 'failed', 'succeeded'].includes(attempt.status))
      || !['running', 'failed', 'succeeded'].includes(value.status)
      || (value.status === 'succeeded' && (value.result?.id !== candidateId
        || !/^[0-9a-f]{64}$/u.test(value.result?.digest)))) throw new ProtocolError('Updater 重试记录损坏')
  return value
}

function retryable(error) {
  return error.retryable === true || error.processResult?.timedOut === true
    || (Number.isInteger(error.processResult?.exitCode)
      && ![0, 125, 126, 127].includes(error.processResult.exitCode))
}

/** 重试同一 Candidate，不推进搜索代数；日志放在候选目录之外，Resume 也不会清空预算。 */
export async function recoverUpdater({ runRoot, candidateId, parentDigest, mutationIdentity = null, supervision,
  operation, verifyResult, onEvent = () => {} }) {
  const policy = updaterSupervision(supervision)
  const path = updaterJournalPath(runRoot, candidateId)
  const directory = join(runRoot, 'updater-attempts', candidateId)
  const root = join(runRoot, 'candidates', candidateId)
  let journal = await readUpdaterJournal(runRoot, candidateId)
  const identity = JSON.stringify({ candidateId, parentDigest, mutationIdentity, policy })
  if (journal && journal.identity !== identity) throw new ProtocolError('Updater 重试记录与父 Candidate 或策略不一致')
  journal ??= { kind: 'UpdaterAttempts', identity, status: 'running', attempts: [] }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const save = async () => {
    const temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(journal, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  }
  const archive = async (attempt) => {
    const info = await lstat(root).catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!info) return
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ProtocolError('Updater Candidate 目录不安全')
    await rename(root, join(directory, `attempt-${attempt}-candidate-${randomUUID()}`))
  }
  if (journal.status === 'succeeded') {
    const result = { ...journal.result, root, workspace: join(root, 'workspace') }
    await verifyResult(result)
    return result
  }
  if (journal.status === 'running' && journal.attempts.length) {
    journal.attempts.at(-1).status = 'interrupted'
    journal.status = 'failed'
    await archive(journal.attempts.length)
    await save()
  }
  if (journal.attempts.length && journal.attempts.at(-1).retryable === false) {
    throw new ProtocolError('上次 Updater 失败不可自动重试；失败证据已保留')
  }
  while (journal.attempts.length <= policy.maximumRetries) {
    const attempt = journal.attempts.length + 1
    if (attempt > 1) {
      onEvent({ stage: 'updater-retry', candidateId, attempt, maximumAttempts: policy.maximumRetries + 1,
        message: `Updater 重试 ${attempt}/${policy.maximumRetries + 1}，复用已完成反馈` })
      await delay(policy.retryDelayMs)
    }
    journal.status = 'running'
    journal.attempts.push({ attempt, status: 'running', startedAt: new Date().toISOString() })
    await save()
    try {
      const result = await operation()
      await verifyResult(result)
      journal.status = 'succeeded'
      journal.result = { id: result.id, digest: result.digest, report: result.report }
      Object.assign(journal.attempts.at(-1), { status: 'succeeded', completedAt: new Date().toISOString() })
      await save()
      return result
    } catch (error) {
      journal.status = 'failed'
      const canRetry = retryable(error)
      Object.assign(journal.attempts.at(-1), { status: 'failed', completedAt: new Date().toISOString(),
        code: typeof error.code === 'string' && /^[a-z0-9_-]{1,80}$/u.test(error.code) ? error.code : 'updater-failed',
        retryable: canRetry })
      await save()
      if (!canRetry) throw error
      await archive(attempt)
    }
  }
  const error = new ProtocolError(`Updater 自动重试预算已耗尽（${policy.maximumRetries + 1} 次尝试）；保留检查点，暂停运行`)
  error.code = 'updater-retry-exhausted'
  error.retryable = false
  throw error
}
