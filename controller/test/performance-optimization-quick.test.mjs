import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { rm } from 'node:fs/promises'
import {
  ConcurrentEvaluationOptimizer,
  DockerImageCacheOptimizer,
  IntermediateResultCache,
  CheckpointOptimizer,
} from '../src/performance-optimization.mjs'

describe('性能优化模块快速测试', () => {
  describe('并发评估优化器', () => {
    it('基础并发评估', async () => {
      const optimizer = new ConcurrentEvaluationOptimizer({ maxConcurrency: 2 })

      const candidates = [{ id: 1 }, { id: 2 }]
      const evaluateFunction = async (candidate) => {
        await new Promise(resolve => setTimeout(resolve, 10))
        return { score: candidate.id * 10 }
      }

      const results = await optimizer.evaluateConcurrently(candidates, evaluateFunction)

      assert.equal(results.length, 2)
      assert.ok(results.every(r => r.result && r.result.score))
    })

    it('统计信息正确', async () => {
      const optimizer = new ConcurrentEvaluationOptimizer({ maxConcurrency: 2 })
      const candidates = [{ id: 1 }]
      const evaluateFunction = async () => ({ success: true })

      await optimizer.evaluateConcurrently(candidates, evaluateFunction)

      const stats = optimizer.getStats()
      assert.equal(stats.completed, 1)
      assert.equal(stats.active, 0)
    })
  })

  describe('Docker 镜像缓存优化器', () => {
    const testCacheDir = '/tmp/rsi-docker-cache-quick-test'

    it('基础缓存功能', async () => {
      const optimizer = new DockerImageCacheOptimizer({ cacheDir: testCacheDir })
      await optimizer.initialize()

      const imageName = 'ubuntu:20.04'

      assert.equal(await optimizer.isCached(imageName), false)
      await optimizer.markCached(imageName)
      assert.equal(await optimizer.isCached(imageName), true)

      await rm(testCacheDir, { recursive: true, force: true })
    })
  })

  describe('中间结果缓存', () => {
    it('基础缓存操作', async () => {
      const cache = new IntermediateResultCache()
      await cache.initialize()

      const key = cache.computeKey('evaluation', { candidateId: 123 })
      const value = { score: 95 }

      await cache.set(key, value)
      const retrieved = await cache.get(key)

      assert.deepEqual(retrieved, value)
    })

    it('缓存键稳定', async () => {
      const cache = new IntermediateResultCache()
      await cache.initialize()

      const key1 = cache.computeKey('evaluation', { a: 1, b: 2 })
      const key2 = cache.computeKey('evaluation', { b: 2, a: 1 })

      assert.equal(key1, key2)
    })
  })

  describe('Checkpoint 优化器', () => {
    const testCheckpointDir = '/tmp/rsi-checkpoint-quick-test'

    it('保存和恢复', async () => {
      const optimizer = new CheckpointOptimizer({ checkpointDir: testCheckpointDir })
      await optimizer.initialize()

      const state = { generation: 5, bestScore: 100 }
      const checkpointId = await optimizer.saveCheckpoint('test', state)
      const restored = await optimizer.restoreCheckpoint(checkpointId)

      assert.deepEqual(restored, state)

      await rm(testCheckpointDir, { recursive: true, force: true })
    })

    it('增量保存', async () => {
      const optimizer = new CheckpointOptimizer({
        checkpointDir: testCheckpointDir,
        incrementalEnabled: true,
      })
      await optimizer.initialize()

      const state1 = { a: 1, b: 2 }
      const state2 = { a: 1, b: 20, c: 3 }

      await optimizer.saveCheckpoint('test', state1)
      const cp2 = await optimizer.saveCheckpoint('test', state2)

      const restored = await optimizer.restoreCheckpoint(cp2)

      assert.equal(restored.a, 1)
      assert.equal(restored.b, 20)
      assert.equal(restored.c, 3)

      await rm(testCheckpointDir, { recursive: true, force: true })
    })
  })

  describe('性能基准', () => {
    it('并发评估性能', async () => {
      const optimizer = new ConcurrentEvaluationOptimizer({ maxConcurrency: 5 })
      const candidates = Array.from({ length: 10 }, (_, i) => ({ id: i }))
      const evaluateFunction = async () => {
        await new Promise(resolve => setTimeout(resolve, 5))
        return { score: 100 }
      }

      const start = performance.now()
      await optimizer.evaluateConcurrently(candidates, evaluateFunction)
      const duration = performance.now() - start

      assert.ok(duration < 100, `并发评估耗时 ${duration}ms`)
    })

    it('缓存性能', async () => {
      const cache = new IntermediateResultCache()
      await cache.initialize()

      const start = performance.now()
      for (let i = 0; i < 50; i += 1) {
        const key = cache.computeKey('test', { id: i % 25 })
        await cache.set(key, { value: i })
      }
      const duration = performance.now() - start

      assert.ok(duration < 50, `缓存操作耗时 ${duration}ms`)
    })
  })
})
