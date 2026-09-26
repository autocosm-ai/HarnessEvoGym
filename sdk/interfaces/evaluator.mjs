/**
 * Evaluator 接口定义
 *
 * Evaluator 用于独立评估环节（Sealed Final Evaluation），负责：
 * 1. 在隐藏测试集上运行 Candidate
 * 2. 计算最终分数和排名
 * 3. 生成评估报告
 *
 * 信任边界：
 * - Evaluator 属于信任根，不能由 Candidate 或 Updater 修改
 * - Hidden Partition 和 Final Rubric 只对 Evaluator 可见
 * - Evaluator 不得泄露隐藏任务细节到反馈中
 *
 * @example
 * ```yaml
 * # plugin.yaml
 * protocol:
 *   kind: evaluator
 *   version: v1
 *   implementation: sealed-docker-evaluator
 * capabilities:
 *   rubrics: [accuracy, efficiency, robustness]
 * trust:
 *   mode: trusted
 * ```
 */

/**
 * @typedef {Object} EvaluationManifest
 * @property {string[]} candidateIds - 待评估的 Candidate ID 列表
 * @property {Object} rubric - 评分标准
 * @property {Object} hiddenPartition - 隐藏测试集配置
 * @property {Object} [policy] - 评估策略（超时、重试、并行度）
 */

/**
 * @typedef {Object} CandidateScore
 * @property {string} candidateId - Candidate ID
 * @property {Object} metrics - 各项指标分数
 * @property {number} totalScore - 总分
 * @property {number} rank - 排名
 * @property {Object} [details] - 详细试炼结果（可选）
 */

/**
 * @typedef {Object} EvaluationReport
 * @property {string} evaluationId - 评估批次 ID
 * @property {string} timestamp - 评估时间戳
 * @property {CandidateScore[]} scores - 所有 Candidate 的分数
 * @property {Object} summary - 汇总统计
 * @property {Object} identity - ExecutionIdentity（确保可复现）
 */

/**
 * Evaluator 接口
 */
export class Evaluator {
  /**
   * 验证评估清单（检查 Candidate 是否存在、Rubric 是否合法）
   * @param {EvaluationManifest} manifest
   * @returns {Promise<void>}
   * @throws {Error} 验证失败时抛出错误
   */
  async validateManifest(manifest) {
    throw new Error('validateManifest() 必须由子类实现')
  }

  /**
   * 运行独立评估
   * @param {Object} options
   * @param {EvaluationManifest} options.manifest - 评估清单
   * @param {string} options.workspaceRoot - 工作区根目录
   * @param {Object} options.context - 运行上下文（Environment / Solver / Docker 等）
   * @returns {Promise<EvaluationReport>}
   */
  async evaluate({ manifest, workspaceRoot, context }) {
    throw new Error('evaluate() 必须由子类实现')
  }

  /**
   * 生成人类可读的评估报告（Markdown / HTML）
   * @param {EvaluationReport} report
   * @param {string} format - 输出格式：markdown / html / json
   * @returns {Promise<string>}
   */
  async formatReport(report, format = 'markdown') {
    throw new Error('formatReport() 必须由子类实现')
  }

  /**
   * 验证评估结果的完整性（防止篡改）
   * @param {EvaluationReport} report
   * @returns {Promise<boolean>}
   */
  async verifyIntegrity(report) {
    // 可选实现：检查签名、哈希、审计日志
    return true
  }
}

/**
 * Evaluator 工厂函数签名
 * @callback EvaluatorFactory
 * @param {Object} options - Controller 传入的初始化参数
 * @returns {Evaluator}
 */
