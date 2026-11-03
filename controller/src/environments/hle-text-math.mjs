import { TextReasoningEnvironment } from './text-reasoning.mjs'
import { callHleJudge } from '../hle-partition-runner.mjs'
import { SolverFailure, SOLVER_FAILURE_PROTOCOL } from '../solver-failure.mjs'

/** HLE 的 Docker 执行路径；共用任务隔离与 Checkpoint，复用原有可信 Judge。 */
export class HleTextMathEnvironment extends TextReasoningEnvironment {
  constructor(options) {
    super(options)
    this.taskKind = 'HleTextMathTasks'
    this.judge = options.judge ?? callHleJudge
  }

  describeCapabilities() {
    return { ...super.describeCapabilities(), scoreType: 'hle-judge-correctness-v1' }
  }

  async gradeAnswer(task, answer) {
    const config = this.environment.judge
    try {
      const result = await this.judge({
        upstreamBaseUrl: process.env[this.environment.modelGateway.upstreamBaseUrlEnvironment],
        getApiKey: async () => process.env[this.environment.modelGateway.upstreamApiKeyEnvironment],
        model: config.model, reasoningEffort: config.reasoningEffort,
        maximumOutputTokens: config.maxTokens, timeoutMs: config.timeoutSeconds * 1000,
        record: { question: task.instruction, answer: task.answer }, response: answer,
      })
      return { reward: result.correct ? 1 : 0, feedback: `可信 HLE Judge 判定答案${result.correct ? '正确' : '错误'}。`,
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0 }
    } catch (cause) {
      throw new SolverFailure({ protocol: SOLVER_FAILURE_PROTOCOL, category: 'trusted-runtime',
        code: 'verifier-infrastructure', terminal: false, context: { instanceId: task.id },
        process: null, diagnostics: null }, { cause })
    }
  }
}
