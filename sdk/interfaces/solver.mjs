/**
 * Solver Driver 接口定义
 *
 * Solver 是 Candidate 的运行时容器，负责：
 * 1. 准备 Candidate 运行环境（Docker 镜像、依赖安装）
 * 2. 执行 Candidate 代码并返回结果
 * 3. 计量 Model Usage（Token、请求数）
 * 4. 隔离 Candidate 与 Controller（文件系统、网络、API 凭据）
 *
 * @example
 * ```yaml
 * # plugin.yaml
 * protocol:
 *   kind: solver
 *   version: v1
 *   implementation: custom-python-sandbox
 * capabilities:
 *   languages: [python, javascript]
 *   modelProviders: [anthropic, openai]
 * trust:
 *   mode: sandbox
 *   permissions: [filesystem-read, network]
 * ```
 */

/**
 * @typedef {Object} ModelAccess
 * @property {string} endpoint - Model Gateway 端点 URL
 * @property {string} token - 临时访问令牌（每次试炼后轮换）
 * @property {string} model - 模型名称
 * @property {number} maxTokens - 最大输出 Token 数
 */

/**
 * @typedef {Object} SolverRuntime
 * @property {string} id - Runtime 唯一标识
 * @property {string} image - Docker 镜像名称（如果适用）
 * @property {string} [imageDigest] - 镜像 SHA256 摘要
 */

/**
 * @typedef {Object} SolverResult
 * @property {boolean} success - 是否成功完成（不代表答案正确）
 * @property {Object} output - Candidate 输出
 * @property {number} exitCode - 进程退出码
 * @property {string} [stdout] - 标准输出（截断）
 * @property {string} [stderr] - 标准错误（截断）
 * @property {Object} [error] - 错误详情
 * @property {Object} modelUsage - Model 用量统计
 */

/**
 * @typedef {Object} ModelUsage
 * @property {boolean} complete - 计量是否完整（Gateway 可能丢失部分记录）
 * @property {number} requests - 接受的请求数
 * @property {number} usageResponses - 返回 usage 的响应数
 * @property {number} unknownUsageResponses - 未返回 usage 的响应数
 * @property {number|null} inputTokens - 输入 Token 总数
 * @property {number|null} outputTokens - 输出 Token 总数
 * @property {number|null} totalTokens - 总 Token 数
 * @property {number} observedInputTokens - 观测到的输入 Token（即使 complete=false）
 * @property {number} observedOutputTokens - 观测到的输出 Token（即使 complete=false）
 * @property {number|null} cacheReadTokens - 缓存命中 Token 数
 * @property {number|null} reasoningTokens - 推理 Token 数
 */

/**
 * Solver Driver 接口
 */
export class SolverDriver {
  /**
   * 准备 Solver 运行时（拉取镜像、构建容器、安装依赖）
   * @param {Object} options
   * @param {string} [options.baseImage] - 基础镜像名称
   * @param {string} [options.baseImageIdentity] - 基础镜像 SHA256
   * @param {string} [options.tag] - 运行时标签
   * @returns {Promise<SolverRuntime>}
   */
  async ensureRuntime({ baseImage, baseImageIdentity, tag }) {
    throw new Error('ensureRuntime() 必须由子类实现')
  }

  /**
   * 运行 Candidate 求解单个任务
   * @param {Object} options
   * @param {string} options.candidateWorkspace - Candidate 代码目录
   * @param {string} options.taskWorkspace - 任务工作区目录
   * @param {Object} options.task - 任务输入
   * @param {ModelAccess} options.model - Model Gateway 访问凭据
   * @param {number} options.timeoutMs - 超时时间（毫秒）
   * @param {Object} [options.env] - 额外的环境变量
   * @param {string} options.sessionRoot - 会话根目录（用于缓存、日志）
   * @returns {Promise<SolverResult>}
   */
  async run({
    candidateWorkspace,
    taskWorkspace,
    task,
    model,
    timeoutMs,
    env,
    sessionRoot,
  }) {
    throw new Error('run() 必须由子类实现')
  }

  /**
   * 获取累计 Model Usage（跨多次 run() 调用）
   * @returns {ModelUsage}
   */
  usage() {
    throw new Error('usage() 必须由子类实现')
  }

  /**
   * 获取 Solver 缓存键（用于 Runtime 复用）
   * @returns {string}
   */
  get cacheKey() {
    throw new Error('cacheKey getter 必须由子类实现')
  }

  /**
   * 获取 Solver 唯一标识
   * @returns {string}
   */
  get id() {
    throw new Error('id getter 必须由子类实现')
  }
}

/**
 * Solver Driver 工厂函数签名
 * @callback SolverFactory
 * @param {Object} options - Controller 传入的初始化参数
 * @param {Object} options.target - Target 配置
 * @param {Object} options.provider - Provider 配置
 * @param {Object} options.docker - Docker 客户端实例
 * @param {string} options.repositoryRoot - 仓库根目录
 * @param {string} options.sourceRevision - Candidate 源码 Git commit
 * @param {string} options.sourcePath - Candidate 代码相对路径
 * @param {Object} options.modelGateway - Model Gateway 实例
 * @returns {SolverDriver}
 */
