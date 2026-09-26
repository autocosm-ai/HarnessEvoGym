import { EnvironmentDriver } from '../../interfaces/environment.mjs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Fake Environment - 用于测试插件系统，无需真实 API Key
 *
 * 任务格式：简单的数学题（加法、乘法、平方）
 * 评分标准：Candidate 输出是否等于正确答案
 */
export class FakeEnvironment extends EnvironmentDriver {
  constructor({ config = {} }) {
    super()
    this.config = {
      taskCount: config.taskCount ?? 10,
      difficulty: config.difficulty ?? 'easy',
      seed: config.seed ?? Date.now(),
    }
    this.rng = this._seededRandom(this.config.seed)
  }

  _seededRandom(seed) {
    let state = seed
    return () => {
      state = (state * 9301 + 49297) % 233280
      return state / 233280
    }
  }

  async preflight({ config, workspaceRoot }) {
    // Fake Environment 不需要检查任何外部依赖
    return
  }

  async runCandidatePartition({
    partition,
    candidateWorkspace,
    taskWorkspace,
    config,
    checkpoint,
    identity,
  }) {
    const tasks = this._generateTasks(partition)
    const trials = []

    for (const task of tasks) {
      const result = await this._runSingleTrial({
        task,
        candidateWorkspace,
        taskWorkspace,
      })
      trials.push(result)
    }

    const summary = this._computeSummary(trials)
    const reward = this.computeReward(trials)
    const promotion = this.checkPromotion(summary, reward)

    return {
      partition,
      trials,
      summary,
      reward,
      promotion,
    }
  }

  async _runSingleTrial({ task, candidateWorkspace, taskWorkspace }) {
    // 读取 Candidate 的 solve.mjs（假设 Candidate 实现了这个接口）
    try {
      const solvePath = join(candidateWorkspace, 'solve.mjs')
      const solveModule = await import(solvePath)
      const output = await solveModule.solve(task.input)

      const correct = output === task.answer
      const latency = Math.floor(Math.random() * 100) // 模拟延迟

      return {
        taskId: task.id,
        success: true,
        output,
        metrics: {
          accuracy: correct ? 1.0 : 0.0,
          latency,
        },
      }
    } catch (error) {
      return {
        taskId: task.id,
        success: false,
        output: null,
        metrics: {
          accuracy: 0.0,
          latency: 0,
        },
        error: {
          message: error.message,
          stack: error.stack,
        },
      }
    }
  }

  _generateTasks(partition) {
    const tasks = []
    const count = this.config.taskCount

    for (let i = 0; i < count; i++) {
      const taskId = `${partition}-task-${i + 1}`
      const a = Math.floor(this.rng() * 100)
      const b = Math.floor(this.rng() * 100)

      let operation, answer
      if (this.config.difficulty === 'easy') {
        operation = 'add'
        answer = a + b
      } else if (this.config.difficulty === 'medium') {
        operation = 'multiply'
        answer = a * b
      } else {
        operation = 'square-sum'
        answer = a * a + b * b
      }

      tasks.push({
        id: taskId,
        partition,
        input: { a, b, operation },
        answer,
        metadata: {
          difficulty: this.config.difficulty,
        },
      })
    }

    return tasks
  }

  _computeSummary(trials) {
    const totalTrials = trials.length
    const successfulTrials = trials.filter((t) => t.success).length
    const correctTrials = trials.filter((t) => t.metrics.accuracy === 1.0).length
    const totalLatency = trials.reduce((sum, t) => sum + t.metrics.latency, 0)

    return {
      totalTrials,
      successfulTrials,
      correctTrials,
      avgAccuracy: correctTrials / totalTrials,
      totalLatency,
      avgLatency: totalLatency / totalTrials,
    }
  }

  computeReward(trials) {
    const summary = this._computeSummary(trials)
    // 简单的奖励函数：正确率 - 延迟惩罚
    const accuracyReward = summary.avgAccuracy * 100
    const latencyPenalty = summary.avgLatency * 0.1
    return {
      total: accuracyReward - latencyPenalty,
      breakdown: {
        accuracy: accuracyReward,
        latencyPenalty: -latencyPenalty,
      },
    }
  }

  checkPromotion(summary, reward) {
    // 简单的晋升条件：正确率 >= 80%
    return summary.avgAccuracy >= 0.8
  }

  getCapabilities() {
    return {
      partitions: ['training', 'validation', 'hidden'],
      metrics: ['accuracy', 'latency'],
      checkpointing: true,
      parallelizable: false,
    }
  }

  async listTasks(partition) {
    return this._generateTasks(partition)
  }
}

/**
 * Factory function for Controller registration
 */
export default function createFakeEnvironment(options) {
  return new FakeEnvironment(options)
}
