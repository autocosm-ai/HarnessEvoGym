/**
 * Updater Driver 接口定义
 *
 * Updater 负责：
 * 1. 接收当前 Population 状态和试炼反馈
 * 2. 生成 Mutation（代码修改、超参调整、策略变更）
 * 3. 返回新 Candidate 和变异描述
 *
 * 信任边界：
 * - Updater 必须在隔离环境中运行，因为它会读取 Solver 反馈（可能含恶意注入）
 * - Updater 不得访问 Final Manifest、Hidden Partition、API 凭据
 * - Updater Token 在进入 Selection 前必须轮换
 *
 * @example
 * ```yaml
 * # plugin.yaml
 * protocol:
 *   kind: updater
 *   version: v1
 *   implementation: claude-code-exec
 * capabilities:
 *   mutationTypes: [code-edit, hyperparameter, prompt-rewrite]
 *   languages: [python, javascript, markdown]
 * trust:
 *   mode: sandbox
 *   permissions: [filesystem-read, filesystem-write]
 * ```
 */

/**
 * @typedef {Object} UpdaterContext
 * @property {Object} baseline - Baseline Candidate 信息
 * @property {Object} population - 当前种群状态
 * @property {Object[]} feedback - 试炼反馈（成功/失败案例、错误信息、轨迹）
 * @property {Object} strategy - 策略参数（突变率、选择压力等）
 * @property {Object} [checkpoint] - 断点续传时的检查点
 */

/**
 * @typedef {Object} MutationReport
 * @property {string} type - 变异类型：code-edit / hyperparameter / prompt-rewrite / merge
 * @property {string} description - 变异描述（给人看的）
 * @property {Object[]} changes - 具体修改列表
 * @property {string} [rationale] - 变异理由（Updater 的推理过程）
 */

/**
 * @typedef {Object} UpdaterResult
 * @property {boolean} success - 是否成功生成新 Candidate
 * @property {string} [candidatePath] - 新 Candidate 代码目录（相对于工作区）
 * @property {MutationReport} mutation - 变异报告
 * @property {Object} modelUsage - Model 用量统计
 * @property {Object} [error] - 失败时的错误信息
 */

/**
 * Updater Driver 接口
 */
export class UpdaterDriver {
  /**
   * 准备 Updater 运行时（拉取镜像、构建容器、安装依赖）
   * @param {Object} options
   * @param {string} [options.tag] - 运行时标签
   * @returns {Promise<Object>} Runtime 信息
   */
  async ensureRuntime({ tag } = {}) {
    throw new Error('ensureRuntime() 必须由子类实现')
  }

  /**
   * 准备 Updater 上下文（拷贝 Baseline、反馈数据到隔离目录）
   * @param {Object} options
   * @param {string} options.workspaceRoot - 工作区根目录
   * @param {UpdaterContext} options.context - Updater 输入上下文
   * @returns {Promise<string>} 上下文目录路径
   */
  async stageContext({ workspaceRoot, context }) {
    throw new Error('stageContext() 必须由子类实现')
  }

  /**
   * 运行 Updater 生成新 Candidate
   * @param {Object} options
   * @param {string} options.contextPath - 上下文目录路径（由 stageContext 返回）
   * @param {string} options.outputPath - 输出目录路径
   * @param {Object} options.model - Model Gateway 访问凭据
   * @param {number} options.timeoutMs - 超时时间（毫秒）
   * @param {Object} [options.env] - 额外的环境变量
   * @returns {Promise<UpdaterResult>}
   */
  async run({
    contextPath,
    outputPath,
    model,
    timeoutMs,
    env,
  }) {
    throw new Error('run() 必须由子类实现')
  }

  /**
   * 获取累计 Model Usage
   * @returns {Object}
   */
  usage() {
    throw new Error('usage() 必须由子类实现')
  }

  /**
   * 获取 Updater 唯一标识
   * @returns {string}
   */
  get id() {
    throw new Error('id getter 必须由子类实现')
  }
}

/**
 * Updater Driver 工厂函数签名
 * @callback UpdaterFactory
 * @param {Object} options - Controller 传入的初始化参数
 * @param {Object} options.updater - Updater 配置
 * @param {Object} options.provider - Provider 配置
 * @param {Object} options.docker - Docker 客户端实例
 * @param {string} options.repositoryRoot - 仓库根目录
 * @param {string} options.sourceRevision - Controller 源码 Git commit
 * @param {string} options.sourcePath - Updater 代码相对路径
 * @param {Object} options.modelGateway - Updater 专用 Model Gateway 实例
 * @param {Object} options.solverModelGateway - Solver 专用 Model Gateway 实例（用于轮换令牌）
 * @returns {UpdaterDriver}
 */
