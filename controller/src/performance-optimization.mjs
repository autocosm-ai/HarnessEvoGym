/**
 * RSI 性能优化模块
 *
 * 提供以下优化能力：
 * - 并发评估优化（Concurrent Evaluation）
 * - Docker 镜像缓存优化（Image Cache）
 * - 中间结果缓存（Intermediate Result Cache）
 * - Checkpoint 机制优化（Checkpoint Optimization）
 */

import { randomUUID, createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, rm, rename } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 并发评估优化器
 *
 * 支持多个候选者并发评估，自动管理并发度和资源分配
 */
export class ConcurrentEvaluationOptimizer {
  constructor(options = {}) {
    this.maxConcurrency = options.maxConcurrency ?? 4
    this.timeoutMs = options.timeoutMs ?? 300000 // 5分钟默认超时
    this.retryLimit = options.retryLimit ?? 2
    if (!Number.isSafeInteger(this.maxConcurrency) || this.maxConcurrency < 1) {
      throw new TypeError('maxConcurrency 必须是正整数')
    }
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 1) {
      throw new TypeError('timeoutMs 必须是正数')
    }
    if (!Number.isSafeInteger(this.retryLimit) || this.retryLimit < 0) {
      throw new TypeError('retryLimit 必须是非负整数')
    }
    this.retryOnTimeout = options.retryOnTimeout === true

    this.activeEvaluations = new Set()
    this.completedEvaluations = new Map()
    this.failedEvaluations = new Map()
  }

  /**
   * 并发评估多个候选者
   *
   * @param {Array} candidates - 候选者列表
   * @param {Function} evaluateFunction - 评估函数 (candidate) => Promise<result>
   * @returns {Promise<Array>} 评估结果列表
   */
  async evaluateConcurrently(candidates, evaluateFunction) {
    if (!Array.isArray(candidates)) {
      throw new Error('candidates 必须是数组')
    }

    if (typeof evaluateFunction !== 'function') {
      throw new Error('evaluateFunction 必须是函数')
    }

    const results = []
    const pending = candidates.map((candidate, index) => ({ candidate, index }))
    const inProgress = new Map()

    while (pending.length > 0 || inProgress.size > 0) {
      // 启动新的评估直到达到并发上限
      while (pending.length > 0 && inProgress.size < this.maxConcurrency) {
        const { candidate, index } = pending.shift()
        const taskId = randomUUID()

        const evaluationPromise = this._evaluateWithRetry(
          candidate,
          evaluateFunction,
          taskId
        )

        inProgress.set(taskId, { candidate, index, promise: evaluationPromise })
        this.activeEvaluations.add(taskId)
      }

      // 等待任意一个完成
      if (inProgress.size > 0) {
        const taskIds = Array.from(inProgress.keys())
        const promises = taskIds.map(id => inProgress.get(id).promise)

        const result = await Promise.race(promises)
        const completedTaskId = result.taskId
        const completedEntry = inProgress.get(completedTaskId)

        this.activeEvaluations.delete(completedTaskId)
        inProgress.delete(completedTaskId)

        if (result.success) {
          this.completedEvaluations.set(completedTaskId, result)
          results.push({
            index: completedEntry?.index ?? 0,
            candidate: result.candidate,
            result: result.data,
            duration: result.duration,
            retries: result.retries,
          })
        } else {
          this.failedEvaluations.set(completedTaskId, result)
          results.push({
            index: completedEntry?.index ?? 0,
            candidate: result.candidate,
            error: result.error,
            duration: result.duration,
            retries: result.retries,
          })
        }
      }
    }

    return results.sort((a, b) => a.index - b.index).map(({ index, ...result }) => result)
  }

  async _evaluateWithRetry(candidate, evaluateFunction, taskId) {
    const startTime = Date.now()
    let retries = 0
    let lastError = null

    while (retries <= this.retryLimit) {
      try {
        const controller = new AbortController()
        let timer
        const evaluationPromise = Promise.resolve().then(() => evaluateFunction(candidate, {
          signal: controller.signal,
        }))
        const timeoutPromise = new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            const timeout = new Error('Evaluation timeout')
            timeout.code = 'EVALUATION_TIMEOUT'
            reject(timeout)
          }, this.timeoutMs)
        })
        let data
        try {
          data = await Promise.race([evaluationPromise, timeoutPromise])
        } finally {
          clearTimeout(timer)
        }

        return {
          taskId,
          candidate,
          success: true,
          data,
          duration: Date.now() - startTime,
          retries,
        }
      } catch (error) {
        lastError = error
        if (error?.code === 'EVALUATION_TIMEOUT' && !this.retryOnTimeout) break
        retries += 1

        if (retries <= this.retryLimit) {
          // 指数退避
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, retries) * 1000))
        }
      }
    }

    return {
      taskId,
      candidate,
      success: false,
      error: lastError?.message ?? 'Evaluation failed',
      duration: Date.now() - startTime,
      // 超时且明确不重试时，retries 不能返回 -1。
      retries: Math.max(0, retries - 1),
    }
  }

  /**
   * 获取当前统计信息
   */
  getStats() {
    return {
      active: this.activeEvaluations.size,
      completed: this.completedEvaluations.size,
      failed: this.failedEvaluations.size,
      maxConcurrency: this.maxConcurrency,
    }
  }

  /**
   * 重置状态
   */
  reset() {
    this.activeEvaluations.clear()
    this.completedEvaluations.clear()
    this.failedEvaluations.clear()
  }
}

/**
 * Docker 镜像缓存优化器
 *
 * 管理 Docker 镜像的本地缓存，避免重复拉取
 */
export class DockerImageCacheOptimizer {
  constructor(options = {}) {
    this.cacheDir = options.cacheDir ?? '/tmp/rsi-docker-cache'
    this.maxCacheSize = options.maxCacheSize ?? 10 * 1024 * 1024 * 1024 // 10GB
    this.cacheTTL = options.cacheTTL ?? 7 * 24 * 60 * 60 * 1000 // 7天
    if (!Number.isFinite(this.maxCacheSize) || this.maxCacheSize < 1) throw new TypeError('maxCacheSize 必须为正数')
    if (!Number.isFinite(this.cacheTTL) || this.cacheTTL < 1) throw new TypeError('cacheTTL 必须为正数')

    this.cacheIndex = new Map()
  }

  /**
   * 初始化缓存目录
   */
  async initialize() {
    await mkdir(this.cacheDir, { recursive: true })
    await this._loadCacheIndex()
  }

  /**
   * 检查镜像是否已缓存
   *
   * @param {string} imageName - 镜像名称（如 "ubuntu:20.04"）
   * @returns {Promise<boolean>}
   */
  async isCached(imageName) {
    assertCacheImageName(imageName)
    const cacheKey = this._getCacheKey(imageName)
    const entry = this.cacheIndex.get(cacheKey)

    if (!entry) return false

    // 检查是否过期
    const now = Date.now()
    if (now - entry.cachedAt > this.cacheTTL) {
      await this._evictEntry(cacheKey)
      return false
    }

    entry.lastAccessedAt = Math.max(now, (entry.lastAccessedAt ?? 0) + 1)
    await this._saveCacheIndex()
    return true
  }

  /**
   * 标记镜像已缓存
   *
   * @param {string} imageName - 镜像名称
   * @param {object} metadata - 额外元数据
   */
  async markCached(imageName, metadata = {}) {
    assertCacheImageName(imageName)
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new TypeError('镜像 metadata 必须是对象')
    }
    const cacheKey = this._getCacheKey(imageName)

    const sizeBytes = metadata.sizeBytes ?? 0
    if (!Number.isFinite(sizeBytes) || sizeBytes < 0) throw new TypeError('镜像 sizeBytes 必须是非负数字')
    this.cacheIndex.set(cacheKey, {
      imageName,
      cacheKey,
      cachedAt: Date.now(),
      lastAccessedAt: Date.now(),
      ...Object.fromEntries(Object.entries(metadata).filter(([key]) =>
        !['imageName', 'cacheKey', 'cachedAt', 'lastAccessedAt'].includes(key))),
      sizeBytes,
    })

    await this._evictToSize()
    await this._saveCacheIndex()
  }

  /**
   * 记录镜像访问
   */
  async recordAccess(imageName) {
    assertCacheImageName(imageName)
    const cacheKey = this._getCacheKey(imageName)
    const entry = this.cacheIndex.get(cacheKey)

    if (entry) {
      entry.lastAccessedAt = Date.now()
      await this._saveCacheIndex()
    }
  }

  /**
   * 清理过期缓存
   */
  async cleanupExpired() {
    const now = Date.now()
    const expiredKeys = []

    for (const [key, entry] of this.cacheIndex.entries()) {
      if (now - entry.cachedAt > this.cacheTTL) {
        expiredKeys.push(key)
      }
    }

    for (const key of expiredKeys) {
      await this._evictEntry(key)
    }

    return expiredKeys.length
  }

  /**
   * 获取缓存统计
   */
  getStats() {
    const entries = Array.from(this.cacheIndex.values())
    const now = Date.now()

    return {
      totalEntries: entries.length,
      validEntries: entries.filter(e => now - e.cachedAt <= this.cacheTTL).length,
      expiredEntries: entries.filter(e => now - e.cachedAt > this.cacheTTL).length,
      oldestEntry: entries.length > 0 ? Math.min(...entries.map(e => e.cachedAt)) : null,
      newestEntry: entries.length > 0 ? Math.max(...entries.map(e => e.cachedAt)) : null,
    }
  }

  _getCacheKey(imageName) {
    return createHash('sha256').update(imageName).digest('hex').substring(0, 16)
  }

  async _loadCacheIndex() {
    try {
      const indexPath = join(this.cacheDir, 'index.json')
      const content = await readFile(indexPath, 'utf8')
      const data = JSON.parse(content)

      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('缓存索引必须是对象')
      this.cacheIndex = new Map(Object.entries(data).filter(([key, entry]) =>
        /^[a-f0-9]{16}$/u.test(key)
        && entry && typeof entry === 'object'
        && typeof entry.imageName === 'string'
        && Number.isFinite(entry.cachedAt)
        && Number.isFinite(entry.lastAccessedAt)
        && Number.isFinite(entry.sizeBytes)
        && entry.sizeBytes >= 0))
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('Failed to load cache index:', error.message)
      }
      this.cacheIndex = new Map()
    }
  }

  async _saveCacheIndex() {
    const indexPath = join(this.cacheDir, 'index.json')
    const data = Object.fromEntries(this.cacheIndex)

    await atomicWrite(indexPath, JSON.stringify(data, null, 2))
  }

  async _evictEntry(cacheKey) {
    this.cacheIndex.delete(cacheKey)
    await this._saveCacheIndex()
  }

  async _evictToSize() {
    const entries = [...this.cacheIndex.entries()]
    let total = entries.reduce((sum, [, entry]) => sum + (entry.sizeBytes ?? 0), 0)
    while (total > this.maxCacheSize && entries.length > 0) {
      entries.sort((a, b) => (a[1].lastAccessedAt ?? 0) - (b[1].lastAccessedAt ?? 0))
      const [key, entry] = entries.shift()
      this.cacheIndex.delete(key)
      total -= entry.sizeBytes ?? 0
    }
  }
}

/**
 * 中间结果缓存
 *
 * 缓存评估、变异等中间结果，避免重复计算
 */
export class IntermediateResultCache {
  constructor(options = {}) {
    this.cacheDir = options.cacheDir ?? '/tmp/rsi-result-cache'
    this.maxEntries = options.maxEntries ?? 1000
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000 // 24小时
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1) throw new TypeError('maxEntries 必须为正整数')
    if (!Number.isFinite(this.ttlMs) || this.ttlMs < 1) throw new TypeError('ttlMs 必须为正数')

    this.cache = new Map()
    this.accessCount = new Map()
    // 默认保持内存缓存，避免每次评测都引入磁盘 I/O；需要跨进程恢复时显式
    // 传 persistent: true。
    this.persistent = options.persistent === true
  }

  /**
   * 初始化缓存
   */
  async initialize() {
    await mkdir(this.cacheDir, { recursive: true })
    if (!this.persistent) return
    let files = []
    try { files = await (await import('node:fs/promises')).readdir(this.cacheDir) } catch {}
    for (const file of files.filter((name) => /^[a-f0-9]{64}\.json$/u.test(name))) {
      const key = file.slice(0, -5)
      try {
        const entry = JSON.parse(await readFile(join(this.cacheDir, file), 'utf8'))
        if (entry && Number.isFinite(entry.timestamp) && Date.now() - entry.timestamp <= this.ttlMs) {
          this.cache.set(key, {
            value: safeCacheValue(entry.value),
            timestamp: entry.timestamp,
            lastAccessedAt: entry.lastAccessedAt ?? entry.timestamp,
          })
          this.accessCount.set(key, entry.accessCount ?? 1)
        } else await rm(join(this.cacheDir, file), { force: true })
      } catch { await rm(join(this.cacheDir, file), { force: true }) }
    }
  }

  /**
   * 计算缓存键
   *
   * @param {string} type - 缓存类型（如 "evaluation", "mutation"）
   * @param {object} params - 参数对象
   * @returns {string} 缓存键
   */
  computeKey(type, params) {
    if (typeof type !== 'string' || type.length === 0) throw new TypeError('缓存 type 必须是非空字符串')
    const normalized = stableStringify({ type, params })
    return createHash('sha256').update(normalized).digest('hex')
  }

  /**
   * 获取缓存结果
   *
   * @param {string} key - 缓存键
   * @returns {Promise<any|null>} 缓存的结果，如果不存在或过期返回 null
   */
  async get(key) {
    assertCacheKey(key)
    let entry = this.cache.get(key)
    if (!entry && this.persistent) {
      try {
        const source = JSON.parse(await readFile(join(this.cacheDir, `${key}.json`), 'utf8'))
        if (!source || !Number.isFinite(source.timestamp)) throw new Error('缓存条目无效')
        entry = {
          value: safeCacheValue(source.value),
          timestamp: source.timestamp,
          lastAccessedAt: source.lastAccessedAt ?? source.timestamp,
        }
        this.cache.set(key, entry)
        this.accessCount.set(key, source.accessCount ?? 1)
      } catch (error) {
        if (error.code !== 'ENOENT') await rm(join(this.cacheDir, `${key}.json`), { force: true })
        return null
      }
    }

    if (!entry) return null

    // 检查是否过期
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key)
      this.accessCount.delete(key)
      if (this.persistent) await rm(join(this.cacheDir, `${key}.json`), { force: true })
      return null
    }

    // 记录访问
    this.accessCount.set(key, (this.accessCount.get(key) || 0) + 1)
    entry.lastAccessedAt = Math.max(Date.now(), (entry.lastAccessedAt ?? 0) + 1)
    if (this.persistent) await this._saveEntry(key, entry)
    return structuredClone(entry.value)
  }

  /**
   * 设置缓存结果
   *
   * @param {string} key - 缓存键
   * @param {any} value - 要缓存的值
   */
  async set(key, value) {
    assertCacheKey(key)
    const normalized = safeCacheValue(value)
    // 如果缓存已满，执行 LRU 清理
    if (!this.cache.has(key) && this.cache.size >= this.maxEntries) {
      await this._evictLRU()
    }

    this.cache.set(key, {
      value: normalized,
      timestamp: Date.now(),
      lastAccessedAt: Date.now() + 1,
    })

    this.accessCount.set(key, 1)
    if (this.persistent) await this._saveEntry(key, this.cache.get(key))
  }

  /**
   * 检查缓存是否命中
   */
  async has(key) {
    assertCacheKey(key)
    if (this.cache.has(key)) {
      const entry = this.cache.get(key)
      if (Date.now() - entry.timestamp > this.ttlMs) {
        await this.delete(key)
        return false
      }
      return true
    }
    if (!this.persistent) return false
    const value = await this.get(key)
    return value !== null || this.cache.has(key)
  }

  /**
   * 清除指定缓存
   */
  async delete(key) {
    assertCacheKey(key)
    this.cache.delete(key)
    this.accessCount.delete(key)
    if (this.persistent) await rm(join(this.cacheDir, `${key}.json`), { force: true })
  }

  /**
   * 清除所有缓存
   */
  async clear() {
    if (this.persistent) {
      for (const key of this.cache.keys()) await rm(join(this.cacheDir, `${key}.json`), { force: true })
    }
    this.cache.clear()
    this.accessCount.clear()
  }

  /**
   * 获取缓存统计
   */
  getStats() {
    const entries = Array.from(this.cache.values())
    const now = Date.now()

    return {
      size: this.cache.size,
      maxEntries: this.maxEntries,
      validEntries: entries.filter(e => now - e.timestamp <= this.ttlMs).length,
      expiredEntries: entries.filter(e => now - e.timestamp > this.ttlMs).length,
      totalAccesses: Array.from(this.accessCount.values()).reduce((a, b) => a + b, 0),
      avgAccessesPerEntry: this.cache.size > 0
        ? Array.from(this.accessCount.values()).reduce((a, b) => a + b, 0) / this.cache.size
        : 0,
    }
  }

  /**
   * 清理过期条目
   */
  async cleanupExpired() {
    const now = Date.now()
    const expiredKeys = []

    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttlMs) {
        expiredKeys.push(key)
      }
    }

    for (const key of expiredKeys) {
      this.cache.delete(key)
      this.accessCount.delete(key)
      if (this.persistent) await rm(join(this.cacheDir, `${key}.json`), { force: true })
    }

    return expiredKeys.length
  }

  async _evictLRU() {
    // 按最近访问时间淘汰，名称和行为都是真正的 LRU。
    const [oldestKey] = [...this.cache.entries()].sort(([, left], [, right]) =>
      (left.lastAccessedAt ?? left.timestamp) - (right.lastAccessedAt ?? right.timestamp))[0] ?? []
    if (oldestKey) await this.delete(oldestKey)
  }

  async _saveEntry(key, entry) {
    await atomicWrite(join(this.cacheDir, `${key}.json`), JSON.stringify({
      value: safeCacheValue(entry.value), timestamp: entry.timestamp,
      lastAccessedAt: entry.lastAccessedAt ?? entry.timestamp,
      accessCount: this.accessCount.get(key) ?? 1,
    }))
  }
}

/**
 * Checkpoint 机制优化器
 *
 * 优化 checkpoint 的保存和恢复，支持增量保存和快速恢复
 */
export class CheckpointOptimizer {
  constructor(options = {}) {
    this.checkpointDir = options.checkpointDir ?? '/tmp/rsi-checkpoints'
    this.incrementalEnabled = options.incrementalEnabled !== false
    this.compressionEnabled = options.compressionEnabled !== false
    this.maxCheckpoints = options.maxCheckpoints ?? 10
    if (!Number.isSafeInteger(this.maxCheckpoints) || this.maxCheckpoints < 1) {
      throw new TypeError('maxCheckpoints 必须为正整数')
    }

    this.checkpoints = []
  }

  /**
   * 初始化 checkpoint 目录
   */
  async initialize() {
    await mkdir(this.checkpointDir, { recursive: true })
    await this._loadCheckpointList()
  }

  /**
   * 保存 checkpoint
   *
   * @param {string} name - Checkpoint 名称
   * @param {object} state - 要保存的状态
   * @param {object} options - 保存选项
   * @returns {Promise<string>} Checkpoint ID
   */
  async saveCheckpoint(name, state, options = {}) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/u.test(name)) {
      throw new TypeError('Checkpoint name 只能包含字母、数字、点、下划线和连字符')
    }
    const checkpointId = `${name}-${Date.now()}-${randomUUID().substring(0, 8)}`
    const checkpointPath = join(this.checkpointDir, `${checkpointId}.json`)

    const normalizedState = safeCacheValue(state)
    const normalizedMetadata = safeCacheValue(options.metadata ?? {})
    const checkpoint = {
      id: checkpointId,
      name,
      timestamp: Date.now(),
      state: normalizedState,
      metadata: normalizedMetadata,
    }

    // 如果启用增量保存，只保存变化的部分
    if (this.incrementalEnabled && this.checkpoints.length > 0) {
      const lastCheckpoint = this.checkpoints[this.checkpoints.length - 1]
      // 需要加载上一个 checkpoint 的完整状态
      let lastState = null
      try {
        lastState = await this.restoreCheckpoint(lastCheckpoint.id)
      } catch {
        // 如果无法加载，就不使用增量
      }

      if (lastState) {
        checkpoint.delta = this._computeDelta(lastState, normalizedState)
        checkpoint.baseCheckpointId = lastCheckpoint.id
        delete checkpoint.state // 增量模式不保存完整 state
      }
    }

    await atomicWrite(checkpointPath, JSON.stringify(checkpoint, null, 2))

    this.checkpoints.push({
      id: checkpointId,
      name,
      timestamp: checkpoint.timestamp,
      path: checkpointPath,
      state: normalizedState,
      baseCheckpointId: checkpoint.baseCheckpointId ?? null,
    })

    // 清理旧的 checkpoint
    if (this.checkpoints.length > this.maxCheckpoints) {
      await this._cleanupOldCheckpoints()
    }

    return checkpointId
  }

  /**
   * 恢复 checkpoint
   *
   * @param {string} checkpointId - Checkpoint ID
   * @returns {Promise<object>} 恢复的状态
   */
  async restoreCheckpoint(checkpointId, ancestry = new Set()) {
    const checkpointInfo = this.checkpoints.find(c => c.id === checkpointId)

    if (!checkpointInfo) {
      throw new Error(`Checkpoint not found: ${checkpointId}`)
    }
    if (ancestry.has(checkpointId)) throw new Error(`Checkpoint 依赖存在循环：${checkpointId}`)
    ancestry.add(checkpointId)

    let checkpoint
    try { checkpoint = JSON.parse(await readFile(checkpointInfo.path, 'utf8')) } catch (error) {
      throw new Error(`Checkpoint 内容无效：${checkpointId}：${error.message}`)
    }

    // 如果是增量 checkpoint，需要先恢复基础 checkpoint
    if (checkpoint.baseCheckpointId) {
      const baseState = await this.restoreCheckpoint(checkpoint.baseCheckpointId, ancestry)
      return this._applyDelta(baseState, checkpoint.delta)
    }

    return safeCacheValue(checkpoint.state)
  }

  /**
   * 列出所有 checkpoint
   */
  async listCheckpoints() {
    return this.checkpoints.map(c => ({
      id: c.id,
      name: c.name,
      timestamp: c.timestamp,
      age: Date.now() - c.timestamp,
    }))
  }

  /**
   * 删除指定 checkpoint
   */
  async deleteCheckpoint(checkpointId) {
    const index = this.checkpoints.findIndex(c => c.id === checkpointId)

    if (index === -1) {
      throw new Error(`Checkpoint not found: ${checkpointId}`)
    }

    const checkpoint = this.checkpoints[index]
    const dependents = this.checkpoints.filter((item) => item.baseCheckpointId === checkpointId)
    for (const dependent of dependents) {
      const fullState = await this.restoreCheckpoint(dependent.id)
      const content = JSON.parse(await readFile(dependent.path, 'utf8'))
      delete content.delta
      delete content.baseCheckpointId
      content.state = safeCacheValue(fullState)
      await atomicWrite(dependent.path, JSON.stringify(content, null, 2))
      dependent.state = content.state
      dependent.baseCheckpointId = null
    }
    await rm(checkpoint.path, { force: true })

    this.checkpoints.splice(index, 1)
  }

  /**
   * 获取统计信息
   */
  getStats() {
    const now = Date.now()
    const ages = this.checkpoints.map(c => now - c.timestamp)

    return {
      totalCheckpoints: this.checkpoints.length,
      maxCheckpoints: this.maxCheckpoints,
      incrementalEnabled: this.incrementalEnabled,
      oldestCheckpoint: ages.length > 0 ? Math.max(...ages) : null,
      newestCheckpoint: ages.length > 0 ? Math.min(...ages) : null,
      avgAge: ages.length > 0 ? ages.reduce((a, b) => a + b, 0) / ages.length : null,
    }
  }

  async _loadCheckpointList() {
    // 扫描 checkpoint 目录
    this.checkpoints = []
    try {
      const { readdir } = await import('node:fs/promises')
      const files = await readdir(this.checkpointDir)

      for (const file of files) {
        if (file.endsWith('.json')) {
          const path = join(this.checkpointDir, file)
          try {
            const content = await readFile(path, 'utf8')
            const checkpoint = JSON.parse(content)

            if (!checkpoint || typeof checkpoint.id !== 'string'
                || !/^[A-Za-z0-9._-]{1,140}$/u.test(checkpoint.id)
                || !Number.isFinite(checkpoint.timestamp)) throw new Error('checkpoint metadata 无效')
            this.checkpoints.push({
              id: checkpoint.id,
              name: checkpoint.name,
              timestamp: checkpoint.timestamp,
              path,
              baseCheckpointId: checkpoint.baseCheckpointId ?? null,
            })
          } catch (error) {
            console.warn(`Failed to load checkpoint ${file}:`, error.message)
          }
        }
      }

      // 按时间排序
      this.checkpoints.sort((a, b) => a.timestamp - b.timestamp)
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('Failed to load checkpoint list:', error.message)
      }
    }
  }

  async _cleanupOldCheckpoints() {
    while (this.checkpoints.length > this.maxCheckpoints) {
      const oldest = this.checkpoints[0]
      const dependent = this.checkpoints.find((item) => item !== oldest && item.baseCheckpointId === oldest.id)
      if (dependent) {
        // 先把直接依赖物化为完整状态，再安全删除基础节点。
        const fullState = await this.restoreCheckpoint(dependent.id)
        const content = JSON.parse(await readFile(dependent.path, 'utf8'))
        delete content.delta
        delete content.baseCheckpointId
        content.state = safeCacheValue(fullState)
        await atomicWrite(dependent.path, JSON.stringify(content, null, 2))
        dependent.state = content.state
        dependent.baseCheckpointId = null
      }
      this.checkpoints.shift()
      await rm(oldest.path, { force: true })
    }
  }

  _computeDelta(oldState, newState) {
    const delta = { added: {}, modified: {}, removed: [] }

    // 简化的 delta 计算（实际应该更复杂）
    const oldStateObj = oldState || {}
    const newStateObj = newState || {}

    for (const key of Object.keys(newStateObj)) {
      if (!(key in oldStateObj)) {
        delta.added[key] = newStateObj[key]
      } else if (JSON.stringify(oldStateObj[key]) !== JSON.stringify(newStateObj[key])) {
        delta.modified[key] = newStateObj[key]
      }
    }

    for (const key of Object.keys(oldStateObj)) {
      if (!(key in newStateObj)) {
        delta.removed.push(key)
      }
    }

    return delta
  }

  _applyDelta(baseState, delta) {
    const result = { ...baseState }

    for (const key of Object.keys(delta.added)) {
      result[key] = delta.added[key]
    }

    for (const key of Object.keys(delta.modified)) {
      result[key] = delta.modified[key]
    }

    for (const key of delta.removed) {
      delete result[key]
    }

    return result
  }
}

function stableStringify(value) {
  const seen = new Set()
  function encode(current) {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return JSON.stringify(current)
    if (typeof current === 'number' && Number.isFinite(current)) return JSON.stringify(current)
    if (!current || typeof current !== 'object' || seen.has(current)) throw new TypeError('缓存键参数必须是无循环的 JSON')
    const prototype = Object.getPrototypeOf(current)
    if (!Array.isArray(current) && prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('缓存键参数必须是普通 JSON')
    }
    seen.add(current)
    let encoded
    if (Array.isArray(current)) encoded = `[${current.map(encode).join(',')}]`
    else encoded = `{${Object.keys(current).sort().map((key) => `${JSON.stringify(key)}:${encode(current[key])}`).join(',')}}`
    seen.delete(current)
    return encoded
  }
  return encode(value)
}

function safeCacheValue(value) {
  return JSON.parse(stableStringify(value))
}

function assertCacheKey(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw new TypeError('缓存 key 必须是 64 位 SHA-256')
}

function assertCacheImageName(value) {
  if (typeof value !== 'string' || value.trim().length === 0 || /[\u0000\r\n]/u.test(value)) {
    throw new TypeError('镜像名称必须是非空安全字符串')
  }
}

async function atomicWrite(path, content) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}
