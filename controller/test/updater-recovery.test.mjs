import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { recoverUpdater, readUpdaterJournal } from '../src/updater-recovery.mjs'
import { UpdaterExecutionError } from '../src/updater-watchdog.mjs'
import { archiveIncompleteCoworkGeneration } from '../src/cowork-orchestrator.mjs'

async function fixture(t) {
  const runRoot = await mkdtemp(join(tmpdir(), 'updater-recovery-'))
  t.after(() => rm(runRoot, { recursive: true, force: true }))
  const candidateId = 'g001-l1', root = join(runRoot, 'candidates', candidateId)
  const create = async () => {
    await mkdir(join(root, 'workspace'), { recursive: true })
    await writeFile(join(root, 'workspace/keep.txt'), 'candidate')
    return { id: candidateId, root, workspace: join(root, 'workspace'), digest: 'a'.repeat(64), report: {} }
  }
  return { runRoot, candidateId, root, create, parentDigest: 'b'.repeat(64),
    supervision: { maximumRetries: 2, retryDelayMs: 0 }, verifyResult: async (r) => {
      assert.equal(await readFile(join(r.workspace, 'keep.txt'), 'utf8'), 'candidate')
    } }
}

test('失败现场归档后重试同一个 Candidate；成功结果跨实例复用，不重复执行 Updater', async (t) => {
  const f = await fixture(t); let calls = 0
  const operation = async () => {
    calls++
    const value = await f.create()
    if (calls === 1) throw new UpdaterExecutionError('updater-repetitive-output')
    return value
  }
  assert.equal((await recoverUpdater({ ...f, operation })).id, f.candidateId)
  assert.equal(calls, 2)
  const saved = await readUpdaterJournal(f.runRoot, f.candidateId)
  assert.deepEqual(saved.attempts.map((x) => x.status), ['failed', 'succeeded'])
  assert.ok((await readdir(join(f.runRoot, 'updater-attempts', f.candidateId))).some((x) => x.startsWith('attempt-1-candidate-')))
  await recoverUpdater({ ...f, operation })
  assert.equal(calls, 2)
  await assert.rejects(recoverUpdater({ ...f, mutationIdentity: 'changed-mutation-lease', operation }), /不一致/u)
  const archived = await archiveIncompleteCoworkGeneration({ runRoot: f.runRoot,
    state: { metadata: { status: 'running' }, spec: { generationsCompleted: 0, mutationLevel: 'l1', candidates: [] } } })
  assert.equal(archived, null)
  await writeFile(join(f.root, 'workspace/keep.txt'), 'tampered')
  await assert.rejects(recoverUpdater({ ...f, operation }))
  assert.equal(calls, 2)
})

test('重试次数耗尽后暂停；新实例和人工 resume 不能清零重试预算', async (t) => {
  const f = await fixture(t); let calls = 0
  const operation = async () => { calls++; await f.create(); throw new UpdaterExecutionError('updater-idle-timeout') }
  for (let i = 0; i < 2; i++) {
    await assert.rejects(recoverUpdater({ ...f, operation }), (error) => error.code === 'updater-retry-exhausted')
  }
  assert.equal(calls, 3)
  assert.equal((await readUpdaterJournal(f.runRoot, f.candidateId)).attempts.length, 3)
  await assert.rejects(recoverUpdater({ ...f, parentDigest: 'c'.repeat(64), operation }), /不一致/u)
})

test('非法提案不自动重试，保留现场给原 Candidate 拒绝流程', async (t) => {
  const f = await fixture(t); let calls = 0
  const error = new Error('invalid mutation')
  const operation = async () => { calls++; await f.create(); throw error }
  await assert.rejects(recoverUpdater({ ...f, operation }), (e) => e === error)
  assert.equal(calls, 1)
  assert.equal(await readFile(join(f.root, 'workspace/keep.txt'), 'utf8'), 'candidate')
})

test('进程崩溃留下的 running 尝试也占用预算并归档，不能无限重启', async (t) => {
  const f = await fixture(t)
  await f.create()
  const directory = join(f.runRoot, 'updater-attempts', f.candidateId)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'state.json'), JSON.stringify({ kind: 'UpdaterAttempts', status: 'running',
    identity: JSON.stringify({ candidateId: f.candidateId, parentDigest: f.parentDigest, mutationIdentity: null,
      policy: { maximumRetries: 2, idleTimeoutSeconds: 600, retryDelayMs: 0 } }),
    attempts: [{ attempt: 1, status: 'running' }],
  }))
  let calls = 0
  await recoverUpdater({ ...f, operation: async () => { calls++; return f.create() } })
  assert.equal(calls, 1)
  assert.deepEqual((await readUpdaterJournal(f.runRoot, f.candidateId)).attempts.map((x) => x.status), ['interrupted', 'succeeded'])
})
