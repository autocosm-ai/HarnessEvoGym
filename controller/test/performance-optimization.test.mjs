import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { rm } from 'node:fs/promises'
import {
  ConcurrentEvaluationOptimizer,
  DockerImageCacheOptimizer,
  IntermediateResultCache,
  CheckpointOptimizer,
} from '../src/performance-optimization.mjs'

describe('性能优化模块测试', () => {
  describe('并发评估优化器', () => {
    it('基础并发评估：2个候选者并发执行', async () => {
      const optimizer = new ConcurrentEvaluationOptimizer({ maxConcurrency: 2 })

      const candidates = [
        { id: 1, name: 'candidate-1' },
        { id: 2, name: 'candidate-2' },
      ]

      const evaluateFunction = async (candidate) => {
        await new Promise(resolve => setTimeout(resolve, 50))
        return { score: candidate.id * 10 }
      }

      const results = await optimizer.evaluateConcurrently(candidates, evaluateFunction)

      assert.equal(results.length, 2)
      assert.equal(results[0].candidate.id, 1)
      assert.equal(results[0].result.score, 10)
      assert.equal(results[1].candidate.id, 2)
      assert.equal(results[1].result.score, 20)
    })

    it('返回顺序与输入候选顺序一致，而不是完成顺序', async () => {
      const optimizer = new ConcurrentEvaluationOptimizer({ maxConcurrency: 2 })
      const results = await optimizer.evaluateConcurrently(
        [{ id: 'slow' }, { id: 'fast' }],
        async (candidate) => {
          await new Promise((resolve) => setTimeout(resolve, candidate.id === 'slow' ? 30 : 1))
          return candidate.id
        },
      )
      assert.deepEqual(results.map(({ candidate }) => candidate.id), ['slow', 'fast'])
    })

    it('并发评估遵守并发度限制', async () => {
      const optimizer = new ConcurrentEvaluationOptimizer({ maxConcurrency: 2 })

      let concurrentCount = 0
      let maxObservedConcurrency = 0

      const candidates = Array.from({ length: 5 }, (_, i) => ({ id: i }))

      const evaluateFunction = async () => {
        concurrentCount += 1
        maxObservedConcurrency = Math.max(maxObservedConcurrency, concurrentCount)
        await new Promise(resolve => setTimeout(resolve, 20))
        concurrentCount -= 1
        return { success: true }
      }

      await optimizer.evaluateConcurrently(candidates, evaluateFunction)

      assert.ok(maxObservedConcurrency <= 2, `观察到的最大并发度 ${maxObservedConcurrency} 超过限制 2`)
    })

    it('失败重试机制正常工作', async () => {
      const optimizer = new ConcurrentEvaluationOptimizer({
        maxConcurrency: 1,
        retryLimit: 2,
        timeoutMs: 1000,
      })

      let attemptCount = 0

      const candidates = [{ id: 1 }]
      const evaluateFunction = async () => {
        attemptCount += 1
        if (attemptCount < 2) {
          throw new Error('Simulated failure')
        }
        return { success: true }
      }

      const results = await optimizer.evaluateConcurrently(candidates, evaluateFunction)

      assert.equal(results.length, 1)
      assert.equal(results[0].result.success, true)
      assert.equal(results[0].retries, 1)
      assert.equal(attemptCount, 2)
    })

    it('超时后正确处理', async () => {
      const optimizer = new ConcurrentEvaluationOptimizer({
        maxConcurrency: 1,
        timeoutMs: 50,
        retryLimit: 0,
      })

      const candidates = [{ id: 1 }]
      const evaluateFunction = async () => {
        await new Promise(resolve => setTimeout(resolve, 200))
        return { success: true }
      }

      const results = await optimizer.evaluateConcurrently(candidates, evaluateFunction)

      assert.equal(results.length, 1)
      assert.ok(results[0].error)
      assert.ok(results[0].error.includes('timeout'))
    })

    it('统计信息正确追踪', async () => {
      const optimizer = new ConcurrentEvaluationOptimizer({ maxConcurrency: 2 })

      const candidates = [{ id: 1 }, { id: 2 }]
      const evaluateFunction = async () => ({ success: true })

      await optimizer.evaluateConcurrently(candidates, evaluateFunction)

      const stats = optimizer.getStats()
      assert.equal(stats.active, 0)
      assert.equal(stats.completed, 2)
      assert.equal(stats.maxConcurrency, 2)
    })
  })

  describe('Docker 镜像缓存优化器', () => {
    const testCacheDir = '/tmp/rsi-docker-cache-test'

    it('初始化后可以标记和检查镜像', async () => {
      const optimizer = new DockerImageCacheOptimizer({ cacheDir: testCacheDir })
      await optimizer.initialize()

      const imageName = 'ubuntu:20.04'

      assert.equal(await optimizer.isCached(imageName), false)

      await optimizer.markCached(imageName, { size: 1024 })

      assert.equal(await optimizer.isCached(imageName), true)

      await rm(testCacheDir, { recursive: true, force: true })
    })

    it('访问记录正确更新', async () => {
      const optimizer = new DockerImageCacheOptimizer({ cacheDir: testCacheDir })
      await optimizer.initialize()

      const imageName = 'alpine:latest'
      await optimizer.markCached(imageName)

      const beforeAccess = optimizer.cacheIndex.get(optimizer._getCacheKey(imageName)).lastAccessedAt

      await new Promise(resolve => setTimeout(resolve, 10))
      await optimizer.recordAccess(imageName)

      const afterAccess = optimizer.cacheIndex.get(optimizer._getCacheKey(imageName)).lastAccessedAt

      assert.ok(afterAccess > beforeAccess)

      await rm(testCacheDir, { recursive: true, force: true })
    })

    it('过期缓存能被清理', async () => {
      const optimizer = new DockerImageCacheOptimizer({
        cacheDir: testCacheDir,
        cacheTTL: 100, // 100ms TTL
      })
      await optimizer.initialize()

      await optimizer.markCached('test:1')
      await optimizer.markCached('test:2')

      assert.equal(await optimizer.isCached('test:1'), true)

      await new Promise(resolve => setTimeout(resolve, 150))

      const cleaned = await optimizer.cleanupExpired()
      assert.equal(cleaned, 2)
      assert.equal(await optimizer.isCached('test:1'), false)

      await rm(testCacheDir, { recursive: true, force: true })
    })

    it('统计信息正确', async () => {
      const optimizer = new DockerImageCacheOptimizer({ cacheDir: testCacheDir })
      await optimizer.initialize()

      await optimizer.markCached('image:1')
      await optimizer.markCached('image:2')
      await optimizer.markCached('image:3')

      const stats = optimizer.getStats()
      assert.equal(stats.totalEntries, 3)
      assert.equal(stats.validEntries, 3)
      assert.equal(stats.expiredEntries, 0)

      await rm(testCacheDir, { recursive: true, force: true })
    })
  })

  describe('中间结果缓存', () => {
    const testCacheDir = '/tmp/rsi-result-cache-test'

    it('基础缓存操作：set 和 get', async () => {
      const cache = new IntermediateResultCache({ cacheDir: testCacheDir })
      await cache.initialize()

      const key = cache.computeKey('evaluation', { candidateId: 123 })
      const value = { score: 95, details: 'test' }

      await cache.set(key, value)

      const retrieved = await cache.get(key)
      assert.deepEqual(retrieved, value)

      await rm(testCacheDir, { recursive: true, force: true })
    })

    it('缓存键计算稳定', async () => {
      const cache = new IntermediateResultCache({ cacheDir: testCacheDir })
      await cache.initialize()

      const key1 = cache.computeKey('evaluation', { a: 1, b: 2 })
      const key2 = cache.computeKey('evaluation', { b: 2, a: 1 })

      assert.equal(key1, key2)

      assert.notEqual(
        cache.computeKey('evaluation', { nested: { id: 1 } }),
        cache.computeKey('mutation', { nested: { id: 1 } }),
      )
      assert.notEqual(
        cache.computeKey('evaluation', { nested: { id: 1 } }),
        cache.computeKey('evaluation', { nested: { id: 2 } }),
      )

      await rm(testCacheDir, { recursive: true, force: true })
    })

    it('过期条目返回 null', async () => {
      const cache = new IntermediateResultCache({
        cacheDir: testCacheDir,
        ttlMs: 50,
      })
      await cache.initialize()

      const key = cache.computeKey('test', { id: 1 })
      await cache.set(key, { data: 'test' })

      assert.ok(await cache.has(key))

      await new Promise(resolve => setTimeout(resolve, 100))

      assert.equal(await cache.get(key), null)
      assert.equal(await cache.has(key), false)

      await rm(testCacheDir, { recursive: true, force: true })
    })

    it('LRU 清理机制工作正常', async () => {
      const cache = new IntermediateResultCache({
        cacheDir: testCacheDir,
        maxEntries: 3,
      })
      await cache.initialize()

      const key1 = cache.computeKey('test', { id: 1 })
      const key2 = cache.computeKey('test', { id: 2 })
      const key3 = cache.computeKey('test', { id: 3 })
      const key4 = cache.computeKey('test', { id: 4 })

      await cache.set(key1, 'value1')
      await cache.set(key2, 'value2')
      await cache.set(key3, 'value3')

      // 访问 key1 和 key3，让 key2 成为最少访问
      await cache.get(key1)
      await cache.get(key3)

      // 添加 key4 应该清理 key2
      await cache.set(key4, 'value4')

      assert.equal(cache.cache.size, 3)
      assert.ok(await cache.has(key1))
      assert.equal(await cache.has(key2), false)
      assert.ok(await cache.has(key3))
      assert.ok(await cache.has(key4))

      await rm(testCacheDir, { recursive: true, force: true })
    })

    it('统计信息准确', async () => {
      const cache = new IntermediateResultCache({ cacheDir: testCacheDir })
      await cache.initialize()

      const key1 = cache.computeKey('test', { id: 1 })
      const key2 = cache.computeKey('test', { id: 2 })

      await cache.set(key1, 'v1')
      await cache.set(key2, 'v2')

      await cache.get(key1)
      await cache.get(key1)
      await cache.get(key2)

      const stats = cache.getStats()
      assert.equal(stats.size, 2)
      // set 操作会初始化 accessCount 为 1，然后 get 会增加
      // key1: set(1) + get(1) + get(1) = 3
      // key2: set(1) + get(1) = 2
      // total = 5
      assert.equal(stats.totalAccesses, 5)

      await rm(testCacheDir, { recursive: true, force: true })
    })
  })

  describe('Checkpoint 优化器', () => {
    const testCheckpointDir = '/tmp/rsi-checkpoint-test'

    it('保存和恢复 checkpoint', async () => {
      const optimizer = new CheckpointOptimizer({ checkpointDir: testCheckpointDir })
      await optimizer.initialize()

      const state = { generation: 5, bestScore: 100, population: [1, 2, 3] }

      const checkpointId = await optimizer.saveCheckpoint('test-run', state)

      const restored = await optimizer.restoreCheckpoint(checkpointId)

      assert.deepEqual(restored, state)

      await rm(testCheckpointDir, { recursive: true, force: true })
    })

    it('列出所有 checkpoint', async () => {
      const optimizer = new CheckpointOptimizer({ checkpointDir: testCheckpointDir })
      await optimizer.initialize()

      await optimizer.saveCheckpoint('run-1', { gen: 1 })
      await optimizer.saveCheckpoint('run-1', { gen: 2 })
      await optimizer.saveCheckpoint('run-2', { gen: 1 })

      const list = await optimizer.listCheckpoints()

      assert.equal(list.length, 3)
      assert.ok(list.every(c => c.id && c.name && c.timestamp))

      await rm(testCheckpointDir, { recursive: true, force: true })
    })

    it('增量 checkpoint 正常工作', async () => {
      const optimizer = new CheckpointOptimizer({
        checkpointDir: testCheckpointDir,
        incrementalEnabled: true,
      })
      await optimizer.initialize()

      const state1 = { a: 1, b: 2, c: 3 }
      const state2 = { a: 1, b: 20, d: 4 }

      const cp1 = await optimizer.saveCheckpoint('incremental', state1)
      const cp2 = await optimizer.saveCheckpoint('incremental', state2)

      const restored = await optimizer.restoreCheckpoint(cp2)

      assert.equal(restored.a, 1)
      assert.equal(restored.b, 20)
      assert.equal(restored.c, undefined)
      assert.equal(restored.d, 4)

      await rm(testCheckpointDir, { recursive: true, force: true })
    })

    it('清理旧 checkpoint', async () => {
      const optimizer = new CheckpointOptimizer({
        checkpointDir: testCheckpointDir,
        maxCheckpoints: 3,
      })
      await optimizer.initialize()

      await optimizer.saveCheckpoint('test', { gen: 1 })
      await optimizer.saveCheckpoint('test', { gen: 2 })
      await optimizer.saveCheckpoint('test', { gen: 3 })
      await optimizer.saveCheckpoint('test', { gen: 4 })

      const list = await optimizer.listCheckpoints()
      assert.equal(list.length, 3)

      // 最旧的应该被清理
      const gens = list.map(c => c.name)
      assert.ok(gens.every(n => n === 'test'))

      await rm(testCheckpointDir, { recursive: true, force: true })
    })

    it('清理增量 checkpoint 后，最新 checkpoint 仍然可以恢复', async () => {
      const optimizer = new CheckpointOptimizer({ checkpointDir: testCheckpointDir, maxCheckpoints: 2 })
      await optimizer.initialize()
      await optimizer.saveCheckpoint('resume', { step: 1, value: 'a' })
      await optimizer.saveCheckpoint('resume', { step: 2, value: 'b' })
      const latest = await optimizer.saveCheckpoint('resume', { step: 3, value: 'c' })
      assert.deepEqual(await optimizer.restoreCheckpoint(latest), { step: 3, value: 'c' })
      await rm(testCheckpointDir, { recursive: true, force: true })
    })

    it('删除指定 checkpoint', async () => {
      const optimizer = new CheckpointOptimizer({ checkpointDir: testCheckpointDir })
      await optimizer.initialize()

      const cp1 = await optimizer.saveCheckpoint('test', { id: 1 })
      const cp2 = await optimizer.saveCheckpoint('test', { id: 2 })

      await optimizer.deleteCheckpoint(cp1)

      const list = await optimizer.listCheckpoints()
      assert.equal(list.length, 1)
      assert.equal(list[0].id, cp2)

      await rm(testCheckpointDir, { recursive: true, force: true })
    })

    it('统计信息完整', async () => {
      const optimizer = new CheckpointOptimizer({ checkpointDir: testCheckpointDir })
      await optimizer.initialize()

      await optimizer.saveCheckpoint('test', { gen: 1 })
      await new Promise(resolve => setTimeout(resolve, 10))
      await optimizer.saveCheckpoint('test', { gen: 2 })

      const stats = optimizer.getStats()
      assert.equal(stats.totalCheckpoints, 2)
      assert.ok(stats.oldestCheckpoint > stats.newestCheckpoint)

      await rm(testCheckpointDir, { recursive: true, force: true })
    })
  })

  describe('性能基准', () => {
    it('并发评估 10 个候选者 < 1s', async () => {
      const optimizer = new ConcurrentEvaluationOptimizer({ maxConcurrency: 5 })

      const candidates = Array.from({ length: 10 }, (_, i) => ({ id: i }))
      const evaluateFunction = async () => {
        await new Promise(resolve => setTimeout(resolve, 10))
        return { score: 100 }
      }

      const start = performance.now()
      await optimizer.evaluateConcurrently(candidates, evaluateFunction)
      const duration = performance.now() - start

      // 10个任务，并发度5，每个10ms，理论最快20ms，实际应该 < 200ms
      assert.ok(duration < 200, `并发评估耗时 ${duration}ms 超过 200ms`)
    })

    it('缓存操作 100 次 < 50ms', async () => {
      const cache = new IntermediateResultCache()
      await cache.initialize()

      const start = performance.now()
      for (let i = 0; i < 100; i += 1) {
        const key = cache.computeKey('test', { id: i % 50 })
        if (i % 2 === 0) {
          await cache.set(key, { value: i })
        } else {
          await cache.get(key)
        }
      }
      const duration = performance.now() - start

      assert.ok(duration < 50, `缓存操作耗时 ${duration}ms 超过 50ms`)
    })
  })
})
