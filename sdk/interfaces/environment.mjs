/**
 * Environment Driver 接口定义
 *
 * Environment 负责：
 * 1. 提供任务集（Training / Validation / Hidden）
 * 2. 执行 Candidate 在任务上的试炼并返回 Result
 * 3. 计算 Reward 和 Promotion 条件
 *
 * @example
 * ```yaml
 * # plugin.yaml
 * protocol:
 *   kind: environment
 *   version: v1
 *   implementation: my-custom-env-docker
 * capabilities:
 *   partitions: [training, validation, hidden]
 *   metrics: [accuracy, latency]
 *   checkpointing: true
 * ```
 */

/**
 * @typedef {Object} EnvironmentCapabilities
 * @property {string[]} partitions - 支持的分区类型，如 ['training', 'validation', 'hidden']
 * @property {string[]} metrics - 支持的指标类型，如 ['accuracy', 'f1', 'latency']
 * @property {boolean} checkpointing - 是否支持断点续传
 * @property {boolean} parallelizable - 是否支持并行执行多个试炼
 */

/**
 * @typedef {Object} TaskSpec
 * @property {string} id - 任务唯一标识
 * @property {string} partition - 所属分区：training / validation / hidden
 * @property {Object} input - 任务输入数据
 * @property {Object} [metadata] - 任务元数据（难度、标签等）
 */

/**
 * @typedef {Object} TrialResult
 * @property {string} taskId - 对应的任务 ID
 * @property {boolean} success - 试炼是否成功完成（不代表答案正确）
 * @property {Object} output - Candidate 的输出
 * @property {Object} metrics - 评分指标，如 { accuracy: 0.95, latency: 123 }
 * @property {Object} [traces] - 执行轨迹（用于调试或反馈）
 * @property {Object} [error] - 失败时的错误信息
 */

/**
 * @typedef {Object} PartitionResult
 * @property {string} partition - 分区名称
 * @property {TrialResult[]} trials - 所有试炼结果
 * @property {Object} summary - 汇总指标，如 { avgAccuracy: 0.92, totalLatency: 4567 }
 * @property {Object} reward - 奖励计算结果
 * @property {boolean} promotion - 是否满足晋升条件
 */

/**
 * Environment Driver 接口
 */
export class EnvironmentDriver {
  /**
   * 预检：验证 Environment 配置、依赖、权限是否就绪
   * @param {Object} options
   * @param {Object} options.config - Environment 配置参数
   * @param {string} options.workspaceRoot - 工作区根目录
   * @returns {Promise<void>}
   * @throws {Error} 预检失败时抛出错误
   */
  async preflight({ config, workspaceRoot }) {
    throw new Error('preflight() 必须由子类实现')
  }

  /**
   * 运行 Candidate 在指定分区的所有任务
   * @param {Object} options
   * @param {string} options.partition - 分区名称：training / validation / hidden
   * @param {string} options.candidateWorkspace - Candidate 代码目录
   * @param {string} options.taskWorkspace - 任务工作区目录
   * @param {Object} options.config - Environment 配置参数
   * @param {Object} [options.checkpoint] - 断点续传时的检查点数据
   * @param {Object} options.identity - 执行身份标识（用于可复现性）
   * @returns {Promise<PartitionResult>}
   */
  async runCandidatePartition({
    partition,
    candidateWorkspace,
    taskWorkspace,
    config,
    checkpoint,
    identity,
  }) {
    throw new Error('runCandidatePartition() 必须由子类实现')
  }

  /**
   * 获取 Environment 能力声明
   * @returns {EnvironmentCapabilities}
   */
  getCapabilities() {
    throw new Error('getCapabilities() 必须由子类实现')
  }

  /**
   * 获取指定分区的任务列表（可选，用于提前检查）
   * @param {string} partition
   * @returns {Promise<TaskSpec[]>}
   */
  async listTasks(partition) {
    return []
  }

  /**
   * 计算 Reward（可选，默认在 runCandidatePartition 中完成）
   * @param {TrialResult[]} trials
   * @returns {Object}
   */
  computeReward(trials) {
    throw new Error('computeReward() 需要在 runCandidatePartition() 中实现或单独提供')
  }

  /**
   * 判断是否满足晋升条件（可选，默认在 runCandidatePartition 中完成）
   * @param {Object} summary - 汇总指标
   * @param {Object} reward - 奖励值
   * @returns {boolean}
   */
  checkPromotion(summary, reward) {
    throw new Error('checkPromotion() 需要在 runCandidatePartition() 中实现或单独提供')
  }
}

/**
 * 用于注册 Environment Driver 的工厂函数签名
 * @callback EnvironmentFactory
 * @param {Object} options - Controller 传入的初始化参数
 * @returns {EnvironmentDriver}
 */
