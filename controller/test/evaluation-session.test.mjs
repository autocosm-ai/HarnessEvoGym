import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { snapshotTree, treeDigest } from '../src/candidate.mjs'
import { runEvaluationSession, evaluationStatistics } from '../src/evaluation-session.mjs'
import { resolveEvaluationCandidates } from '../src/evaluation-candidates.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'gym-evaluation-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'candidate')
  await mkdir(workspace)
  await writeFile(join(workspace, 'solve.py'), 'print(1)\n')
  return { root, candidate: { candidateId: 'winner', candidateWorkspace: workspace,
    candidateDigest: treeDigest(await snapshotTree(workspace)) } }
}

function record(id, reward) {
  return { instanceId: id, reward, status: reward ? 'resolved' : 'unresolved', trialRewards: [reward], trialSeeds: [1] }
}

test('公共评测保留真实零分、失败候选不拖累其他候选；恢复不重算完成版本', async (t) => {
  const { root, candidate } = await fixture(t)
  let failing = true
  const calls = []
  const options = { outputRoot: join(root, 'evaluation'), candidates: [candidate, { ...candidate, candidateId: 'other' }],
    environment: { async runCandidatePartition({ candidateId }) {
      calls.push(candidateId)
      if (failing && candidateId === 'winner') throw new Error('upstream fault')
      return new Map([['a', record('a', 0)], ['b', record('b', 1)]])
    } }, partition: 'final', model: { model: 'fixture' }, seeds: [1], expectedIds: ['a', 'b'],
    identityInputs: { metric: 'fixture' } }
  const first = await runEvaluationSession(options)
  assert.equal(first.complete, false)
  assert.equal(first.candidates.winner.meanReward, null)
  assert.equal(first.candidates.other.meanReward, 0.5)
  failing = false
  const second = await runEvaluationSession({ ...options, resume: true })
  assert.equal(second.complete, true)
  assert.deepEqual(calls, ['winner', 'other', 'winner'])
  await assert.rejects(runEvaluationSession({ ...options, resume: true, model: { model: 'changed' } }), /身份发生变化/u)
  assert.deepEqual(calls, ['winner', 'other', 'winner'])
  assert.equal(JSON.parse(await readFile(join(root, 'evaluation/summary.json'))).complete, true)
  const resultPath = join(root, 'evaluation/candidates/winner.json')
  const altered = JSON.parse(await readFile(resultPath, 'utf8'))
  altered.records[0].reward = 1
  await writeFile(resultPath, JSON.stringify(altered))
  const refused = await runEvaluationSession({ ...options, resume: true })
  assert.equal(refused.complete, false)
  assert.equal(refused.candidates.winner.meanReward, null)
})

test('公共评测拒绝缺失 trial、重复题和非有限分数，不用缺题补零', () => {
  for (const rows of [[record('a', 1)], [record('a', 0), record('a', 1)], [record('a', NaN), record('b', 1)]]) {
    assert.throws(() => evaluationStatistics(rows, ['a', 'b'], [1]), /不完整|无效/u)
  }
  assert.throws(() => evaluationStatistics([record('a', 1)], ['a'], [1, 2]), /不完整/u)
})

test('候选选择器只读检查源码，并拒绝工作区逃逸和重复标签', async (t) => {
  const { root, candidate } = await fixture(t)
  const selected = await resolveEvaluationCandidates(root, [{ id: 'h0', workspace: 'candidate' }])
  assert.equal(selected[0].candidateDigest, candidate.candidateDigest)
  await assert.rejects(resolveEvaluationCandidates(root, [{ id: 'h0', workspace: '../' }]), /逃逸/u)
  await assert.rejects(resolveEvaluationCandidates(root, [{ id: 'h0', workspace: 'candidate' }, { id: 'h0', workspace: 'candidate' }]), /唯一/u)
})
