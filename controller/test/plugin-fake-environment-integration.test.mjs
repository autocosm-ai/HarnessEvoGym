import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { autoRegisterPlugin, createPluginDriver } from '../src/plugin-loader.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FAKE_ENV_PATH = resolve(__dirname, '../../sdk/examples/fake-environment')
const FAKE_CANDIDATE_PATH = resolve(__dirname, '../../sdk/examples/fake-candidate')

describe('Fake Environment + Fake Candidate 集成测试', () => {
  it('运行完整的 training partition 试炼', async () => {
    await autoRegisterPlugin(FAKE_ENV_PATH)

    const driver = createPluginDriver('environment', 'fake-deterministic-v1', {
      config: { taskCount: 5, difficulty: 'easy', seed: 42 },
    })

    const taskWorkspace = await mkdtemp(resolve(tmpdir(), 'harness-test-'))

    try {
      const result = await driver.runCandidatePartition({
        partition: 'training',
        candidateWorkspace: FAKE_CANDIDATE_PATH,
        taskWorkspace,
        config: {},
        checkpoint: null,
        identity: { revision: 'test', timestamp: Date.now() },
      })

      assert.equal(result.partition, 'training')
      assert.equal(result.trials.length, 5)

      // 检查所有试炼都成功
      for (const trial of result.trials) {
        assert.ok(trial.success, `Trial ${trial.taskId} 应该成功`)
        assert.equal(trial.metrics.accuracy, 1.0, `Trial ${trial.taskId} 应该正确`)
      }

      // 检查汇总统计
      assert.equal(result.summary.totalTrials, 5)
      assert.equal(result.summary.successfulTrials, 5)
      assert.equal(result.summary.correctTrials, 5)
      assert.equal(result.summary.avgAccuracy, 1.0)

      // 检查 reward
      assert.ok(result.reward.total > 0)
      assert.equal(result.reward.breakdown.accuracy, 100)

      // 检查晋升条件
      assert.ok(result.promotion, '100% 正确率应该满足晋升条件')
    } finally {
      await rm(taskWorkspace, { recursive: true, force: true })
    }
  })

  it('测试不同难度级别', async () => {
    await autoRegisterPlugin(FAKE_ENV_PATH)

    const difficulties = ['easy', 'medium', 'hard']
    const taskWorkspace = await mkdtemp(resolve(tmpdir(), 'harness-test-'))

    try {
      for (const difficulty of difficulties) {
        const driver = createPluginDriver('environment', 'fake-deterministic-v1', {
          config: { taskCount: 3, difficulty, seed: 100 },
        })

        const result = await driver.runCandidatePartition({
          partition: 'training',
          candidateWorkspace: FAKE_CANDIDATE_PATH,
          taskWorkspace,
          config: {},
          checkpoint: null,
          identity: { revision: 'test', timestamp: Date.now() },
        })

        assert.equal(result.summary.avgAccuracy, 1.0, `${difficulty} 难度应该全部正确`)
      }
    } finally {
      await rm(taskWorkspace, { recursive: true, force: true })
    }
  })

  it('测试不同 partition', async () => {
    await autoRegisterPlugin(FAKE_ENV_PATH)

    const driver = createPluginDriver('environment', 'fake-deterministic-v1', {
      config: { taskCount: 3, difficulty: 'easy', seed: 200 },
    })

    const taskWorkspace = await mkdtemp(resolve(tmpdir(), 'harness-test-'))

    try {
      const partitions = ['training', 'validation', 'hidden']

      for (const partition of partitions) {
        const result = await driver.runCandidatePartition({
          partition,
          candidateWorkspace: FAKE_CANDIDATE_PATH,
          taskWorkspace,
          config: {},
          checkpoint: null,
          identity: { revision: 'test', timestamp: Date.now() },
        })

        assert.equal(result.partition, partition)
        assert.equal(result.summary.avgAccuracy, 1.0)
      }
    } finally {
      await rm(taskWorkspace, { recursive: true, force: true })
    }
  })

  it('测试 Candidate 缺失时的错误处理', async () => {
    await autoRegisterPlugin(FAKE_ENV_PATH)

    const driver = createPluginDriver('environment', 'fake-deterministic-v1', {
      config: { taskCount: 2, difficulty: 'easy', seed: 300 },
    })

    const taskWorkspace = await mkdtemp(resolve(tmpdir(), 'harness-test-'))
    const nonExistentCandidate = resolve(taskWorkspace, 'non-existent-candidate')

    try {
      const result = await driver.runCandidatePartition({
        partition: 'training',
        candidateWorkspace: nonExistentCandidate,
        taskWorkspace,
        config: {},
        checkpoint: null,
        identity: { revision: 'test', timestamp: Date.now() },
      })

      // 所有试炼应该失败
      for (const trial of result.trials) {
        assert.equal(trial.success, false)
        assert.equal(trial.metrics.accuracy, 0.0)
        assert.ok(trial.error, '应该有错误信息')
      }

      assert.equal(result.summary.avgAccuracy, 0.0)
      assert.equal(result.promotion, false, '0% 正确率不应该晋升')
    } finally {
      await rm(taskWorkspace, { recursive: true, force: true })
    }
  })

  it('验证确定性：相同 seed 生成相同结果', async () => {
    await autoRegisterPlugin(FAKE_ENV_PATH)

    const seed = 999
    const taskWorkspace = await mkdtemp(resolve(tmpdir(), 'harness-test-'))

    try {
      const results = []

      for (let i = 0; i < 2; i++) {
        const driver = createPluginDriver('environment', 'fake-deterministic-v1', {
          config: { taskCount: 5, difficulty: 'medium', seed },
        })

        const result = await driver.runCandidatePartition({
          partition: 'training',
          candidateWorkspace: FAKE_CANDIDATE_PATH,
          taskWorkspace,
          config: {},
          checkpoint: null,
          identity: { revision: 'test', timestamp: Date.now() },
        })

        results.push(result)
      }

      // 比较两次运行的任务输入
      for (let i = 0; i < results[0].trials.length; i++) {
        const trial1 = results[0].trials[i]
        const trial2 = results[1].trials[i]
        assert.equal(trial1.taskId, trial2.taskId)
        assert.equal(trial1.output, trial2.output)
        assert.equal(trial1.metrics.accuracy, trial2.metrics.accuracy)
      }
    } finally {
      await rm(taskWorkspace, { recursive: true, force: true })
    }
  })
})
