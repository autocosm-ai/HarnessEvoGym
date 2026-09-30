import assert from 'node:assert/strict'
import test from 'node:test'

import { SolverFailure } from '../src/solver-failure.mjs'
import { withTrialInfrastructureRetries } from '../src/trial-infrastructure-retry.mjs'

/**
 * P0-1 和 P0-2 集成测试：验证 API 失败不会被误判为 Candidate 失败，
 * 并且基础设施故障会自动重试
 */

test('模拟 API 429 限流错误会自动重试并最终成功', async () => {
  let attemptCount = 0
  const retryEvents = []

  const result = await withTrialInfrastructureRetries(async () => {
    attemptCount += 1

    // 前两次模拟 429 限流错误
    if (attemptCount <= 2) {
      throw new SolverFailure({
        category: 'provider',
        code: 'upstream-unavailable',
        terminal: false,
        diagnostics: {
          complete: true,
          requests: [{
            origin: 'upstream',
            httpStatus: 429,
            streamError: false,
            transportError: false,
          }],
        },
      })
    }

    // 第三次成功
    return { reward: 1.0, status: 'completed' }
  }, {
    maximumRetries: 3,
    retryReasoningOnly: false,
    sleep: async (ms) => {
      // 跳过实际延迟，只记录
      retryEvents.push(ms)
    },
    beforeRetry: async ({ retry, maximumRetries, delayMs }) => {
      retryEvents.push({ retry, maximumRetries, delayMs })
    },
  })

  // 验证：尝试了 3 次（2 次失败 + 1 次成功）
  assert.equal(attemptCount, 3)

  // 验证：最终返回成功结果
  assert.deepEqual(result, { reward: 1.0, status: 'completed' })

  // 验证：记录了 2 次重试事件
  const retryRecords = retryEvents.filter((e) => typeof e === 'object')
  assert.equal(retryRecords.length, 2)
  assert.equal(retryRecords[0].retry, 1)
  assert.equal(retryRecords[1].retry, 2)
})

test('模拟 API 503 服务不可用错误会重试，超过预算后抛出原始错误', async () => {
  let attemptCount = 0
  const originalError = new SolverFailure({
    category: 'provider',
    code: 'upstream-unavailable',
    terminal: false,
    diagnostics: {
      complete: true,
      requests: [{
        origin: 'upstream',
        httpStatus: 503,
        streamError: false,
        transportError: false,
      }],
    },
  })

  await assert.rejects(
    withTrialInfrastructureRetries(async () => {
      attemptCount += 1
      throw originalError
    }, {
      maximumRetries: 2,
      retryReasoningOnly: false,
      sleep: async () => {},
    }),
    (error) => {
      // 验证：抛出的是原始的 SolverFailure，分类为 provider
      assert.equal(error, originalError)
      assert.equal(error.failure.category, 'provider')
      return true
    },
  )

  // 验证：尝试了 3 次（初始 1 次 + 重试 2 次）
  assert.equal(attemptCount, 3)
})

test('Candidate 失败（非基础设施错误）不会触发重试', async () => {
  let attemptCount = 0
  const candidateError = new SolverFailure({
    category: 'candidate',
    code: 'solution-error',
    terminal: true,
    diagnostics: {
      complete: true,
      requests: [{
        origin: 'upstream',
        httpStatus: 200,
        streamError: false,
        transportError: false,
        contentBytes: 100,
      }],
    },
  })

  await assert.rejects(
    withTrialInfrastructureRetries(async () => {
      attemptCount += 1
      throw candidateError
    }, {
      maximumRetries: 5,
      retryReasoningOnly: false,
      sleep: async () => {
        assert.fail('Candidate 错误不应重试')
      },
    }),
    (error) => {
      assert.equal(error, candidateError)
      assert.equal(error.failure.category, 'candidate')
      return true
    },
  )

  // 验证：只尝试了 1 次，没有重试
  assert.equal(attemptCount, 1)
})

test('模拟网络传输中断会触发重试', async () => {
  let attemptCount = 0

  const result = await withTrialInfrastructureRetries(async () => {
    attemptCount += 1

    // 第一次模拟传输中断
    if (attemptCount === 1) {
      throw new SolverFailure({
        category: 'provider',
        code: 'upstream-stream-interrupted',
        terminal: false,
        diagnostics: {
          complete: true,
          requests: [{
            origin: 'upstream',
            httpStatus: 200,
            streamError: false,
            transportError: true,
            responseComplete: false,
          }],
        },
      })
    }

    // 第二次成功
    return { reward: 0.8, status: 'completed' }
  }, {
    maximumRetries: 3,
    retryReasoningOnly: false,
    sleep: async () => {},
  })

  // 验证：尝试了 2 次
  assert.equal(attemptCount, 2)

  // 验证：最终成功
  assert.deepEqual(result, { reward: 0.8, status: 'completed' })
})

test('验证重试延迟使用指数退避策略', async () => {
  const delays = []
  let attemptCount = 0

  await assert.rejects(
    withTrialInfrastructureRetries(async () => {
      attemptCount += 1
      throw new SolverFailure({
        category: 'provider',
        code: 'upstream-unavailable',
        terminal: false,
        diagnostics: {
          complete: true,
          requests: [{ origin: 'upstream', httpStatus: 502 }],
        },
      })
    }, {
      maximumRetries: 5,
      retryReasoningOnly: false,
      sleep: async (ms) => {
        delays.push(ms)
      },
    }),
  )

  // 验证：指数退避，上限 60 秒
  assert.deepEqual(delays, [
    5000,   // 5 秒
    10000,  // 10 秒
    20000,  // 20 秒
    40000,  // 40 秒
    60000,  // 60 秒（封顶）
  ])
})
