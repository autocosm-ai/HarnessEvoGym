import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import test from 'node:test'
import { REPOSITORY_ROOT } from '../src/config.mjs'
import { runEvaluationJob } from '../src/evaluation-job.mjs'
import { validateResultRecords } from '../src/protocol.mjs'

test('统一评测入口：预检不执行、真实 Runner 提交结果、相同身份恢复、模型变化拒绝复用', async (t) => {
  await mkdir(join(REPOSITORY_ROOT, '.rsi'), { recursive: true })
  const root = await mkdtemp(join(REPOSITORY_ROOT, '.rsi/evaluation-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'candidate'))
  await writeFile(join(root, 'candidate/run.py'), 'print(1)\n')
  const request = { apiVersion: 'harness-rsi/v1alpha1', kind: 'EvaluationJob', spec: {
    mode: 'exploratory', experiment: 'experiments/reasoning-msa-smoke-single.json', partition: 'final',
    output: relative(REPOSITORY_ROOT, join(root, 'evaluation')),
    candidates: [{ id: 'winner', workspace: relative(REPOSITORY_ROOT, join(root, 'candidate')) }], seeds: [10, 20],
  } }
  const configPath = join(root, 'request.json')
  await writeFile(configPath, JSON.stringify(request))
  let calls = 0
  const environmentFactory = async ({ bundle }) => ({ identity: { fixture: true }, async close() {},
    environment: { async runCandidatePartition({ partition, seeds }) {
      calls++
      return new Map(bundle.benchmark.partitions[partition].instanceIds.map((id) => [id, {
        instanceId: id, status: 'unresolved', reward: 0.5, trialRewards: [0, 1], trialSeeds: seeds,
      }]))
    } } })
  const options = { repositoryRoot: REPOSITORY_ROOT, configPath }
  const plan = await runEvaluationJob({ ...options, dryRun: true }, { environmentFactory })
  assert.equal(plan.tasks, 1); assert.equal(calls, 0)
  await assert.rejects(readFile(join(root, 'evaluation/identity.json')), { code: 'ENOENT' })
  assert.equal((await runEvaluationJob(options, { environmentFactory })).complete, true)
  assert.equal((await runEvaluationJob({ ...options, resume: true }, { environmentFactory })).candidates.winner.reused, true)
  assert.equal(calls, 1)
  request.spec.model = { model: 'changed-model' }
  await writeFile(configPath, JSON.stringify(request))
  await assert.rejects(runEvaluationJob({ ...options, resume: true }, { environmentFactory }), /身份发生变化/u)
  assert.equal(calls, 1)
})

test('OfficeVal 原始负分与 Controller 归一化分数同时保留，不能混为同一指标', () => {
  const benchmark = { allInstanceIds: new Set(['task']), partitionByInstance: new Map([['task', 'final']]) }
  const result = validateResultRecords([{ instance_id: 'task', status: 'unresolved', reward: 0,
    trial_rewards: [0], trial_seeds: [1], score_details: { metric: 'officeval-raw-ratio-v1', value: -0.5, trial_values: [-0.5] } }], benchmark, 'fixture')
  assert.equal(result.get('task').reward, 0)
  assert.equal(result.get('task').scoreDetails.value, -0.5)
})
