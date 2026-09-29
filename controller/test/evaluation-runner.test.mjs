import assert from 'node:assert/strict'
import test from 'node:test'

import { runEvaluationPartition } from '../src/evaluation-runner.mjs'

function candidate(id) {
  return { candidateId: id, candidateDigest: `${id}-digest`, candidateWorkspace: `/scratch/${id}` }
}

test('公共 Evaluation Runner 统一调度候选并校验完整题目集合', async () => {
  const calls = []
  const environment = {
    async runCandidatePartition(options) {
      calls.push(options)
      return new Map([['task-1', { status: 'resolved' }], ['task-2', { status: 'unresolved' }]])
    },
  }
  const result = await runEvaluationPartition({
    environment,
    candidates: [candidate('h0'), candidate('c1')],
    partition: 'final',
    model: { id: 'fixture-model' },
    seeds: [1],
    outputPath: (id, partition) => `/out/${id}-${partition}.jsonl`,
    expectedInstanceIds: ['task-1', 'task-2'],
    infrastructureRetries: 3,
  })
  assert.deepEqual([...result.keys()], ['h0', 'c1'])
  assert.equal(calls[0].outputPath, '/out/h0-final.jsonl')
  assert.equal(calls[1].infrastructureRetries, 3)
})

test('公共 Evaluation Runner 拒绝缺题，避免产生不完整平均分', async () => {
  const environment = {
    async runCandidatePartition() { return new Map([['task-1', { status: 'resolved' }]]) },
  }
  await assert.rejects(
    () => runEvaluationPartition({
      environment,
      candidates: [candidate('h0')],
      partition: 'selection',
      model: {},
      seeds: [1],
      outputPath: () => '/out/result.jsonl',
      expectedInstanceIds: ['task-1', 'task-2'],
    }),
    /结果不完整/u,
  )
})

