/**
 * Evolution Algorithm Driver 接口定义
 *
 * Algorithm 负责：
 * 1. 管理种群状态（Population / Cowork / HLE 等不同格式）
 * 2. 决策：选择哪些 Candidate 进行试炼、突变、交叉、淘汰
 * 3. 控制进化流程：初始化 -> 多轮 Run -> 最终报告
 *
 * 当前已有实现：
 * - population-v1: 标准种群算法（多 Candidate 竞争）
 *
 * 未来可扩展：
 * - cowork-v1: 协作式多 Agent（固定分工，协同优化）
 * - hle-v1: 分层进化（底层组件 + 顶层策略）
 *
 * @example
 * ```yaml
 * # plugin.yaml
 * protocol:
 *   kind: algorithm
 *   version: v1
 *   implementation: custom-genetic-algorithm
 * capabilities:
 *   stateFormat: population
 *   strategies: [elitism, tournament, roulette]
 * configuration:
 *   schema:
 *     type: object
 *     properties:
 *       populationSize:
 *         type: integer
 *         minimum: 1
 *       mutationRate:
 *         type: number
 *         minimum: 0
 *         maximum: 1
 * ```
 */

/**
 * @typedef {Object} AlgorithmOptions
 * @property {string} campaignsRoot - Campaign 根目录
 * @property {string} campaignId - 当前 Campaign ID
 * @property {Object} store - PopulationStore 或其他状态存储实例
 * @property {Object} algorithm - Algorithm 配置和参数
 */

/**
 * @typedef {Object} RunContext
 * @property {Object} target - Target 配置
 * @property {Object} environment - Environment 配置
 * @property {Object} solver - Solver 配置
 * @property {Object} updater - Updater 配置
 * @property {Object} strategy - Strategy 配置
 * @property {Object} docker - Docker 客户端实例
 * @property {Object} modelGateway - Model Gateway 实例
 */

/**
 * @typedef {Object} RunResult
 * @property {string} status - 运行状态：completed / failed / paused
 * @property {Object} summary - 汇总统计（试炼数、成功率、最佳分数等）
 * @property {Object} [error] - 失败时的错误信息
 */

/**
 * Evolution Algorithm Driver 接口
 */
export class EvolutionAlgorithmDriver {
  /**
   * 初始化 Campaign（创建 Baseline、初始种群、工作目录）
   * @param {Object} options
   * @param {string} options.baselinePath - Baseline Candidate 代码目录
   * @param {Object} options.initialState - 初始状态（可选，用于从模板启动）
   * @param {RunContext} options.context - 运行上下文
   * @returns {Promise<void>}
   */
  async initialize({ baselinePath, initialState, context }) {
    throw new Error('initialize() 必须由子类实现')
  }

  /**
   * 运行一轮或多轮进化
   * @param {Object} options
   * @param {number} [options.maxGenerations] - 最大代数（null 表示一直运行到收敛）
   * @param {number} [options.maxTrials] - 最大试炼数
   * @param {Object} [options.stopConditions] - 停止条件（目标分数、无改进轮数等）
   * @param {RunContext} options.context - 运行上下文
   * @returns {Promise<RunResult>}
   */
  async run({ maxGenerations, maxTrials, stopConditions, context }) {
    throw new Error('run() 必须由子类实现')
  }

  /**
   * 从检查点恢复运行
   * @param {Object} options
   * @param {string} options.checkpointPath - 检查点文件路径
   * @param {RunContext} options.context - 运行上下文
   * @returns {Promise<RunResult>}
   */
  async resume({ checkpointPath, context }) {
    throw new Error('resume() 必须由子类实现')
  }

  /**
   * 生成最终报告（最佳 Candidate、进化曲线、统计数据）
   * @returns {Promise<Object>}
   */
  async report() {
    throw new Error('report() 必须由子类实现')
  }

  /**
   * 冻结 Baseline（锁定 Candidate 版本和 ExecutionIdentity）
   * @param {Object} options
   * @param {string} options.candidateId - Candidate ID
   * @param {Object} options.identity - ExecutionIdentity
   * @returns {Promise<void>}
   */
  async freezeBaseline({ candidateId, identity }) {
    throw new Error('freezeBaseline() 必须由子类实现')
  }

  /**
   * 获取当前状态存储实例（PopulationStore 或其他）
   * @returns {Object}
   */
  get store() {
    throw new Error('store getter 必须由子类实现')
  }
}

/**
 * Evolution Algorithm 工厂函数签名
 * @callback AlgorithmFactory
 * @param {AlgorithmOptions} options - Controller 传入的初始化参数
 * @returns {EvolutionAlgorithmDriver}
 */
