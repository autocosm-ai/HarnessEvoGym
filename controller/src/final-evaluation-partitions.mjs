import { ProtocolError } from './protocol.mjs'
import { validateInfrastructureRetries } from './trial-infrastructure-retry.mjs'

export function finalEvaluationPolicy({ finalOnly = false, infrastructureRetries = 5 } = {}) {
  if (typeof finalOnly !== 'boolean') throw new ProtocolError('finalOnly 必须是布尔值')
  validateInfrastructureRetries(infrastructureRetries)
  return {
    partitions: finalOnly ? ['final'] : ['feedback', 'final'],
    infrastructureRetries,
    retryUnit: 'uncommitted-task',
  }
}

// 同一次 Final Claim 内锁定 H0/Champion。只测 final 时不重新执行训练题，也不把
// 历史训练分数冒充本次重测结果；generalization gap 由 Evaluator 自然返回 null。
export async function runFinalEvaluationPartitions({
  environment, baseline, candidate, model, seeds, outputPath,
  policy, onEvent = () => {},
}) {
  const baselineRecords = new Map()
  const candidateRecords = new Map()
  for (const partition of policy.partitions) {
    const run = (entry) => environment.runCandidatePartition({
      ...entry, model, partition, seeds,
      outputPath: outputPath(entry.candidateId, partition),
      infrastructureRetries: policy.infrastructureRetries,
      onInfrastructureRetry: ({ retry, maximumRetries, delayMs }) => onEvent({
        stage: 'final-retry',
        // 公共进度只报告重试次数，不泄露隐藏题 ID、题面或上游原文。
        message: `模型接口故障，${delayMs / 1000} 秒后重试当前题（${retry}/${maximumRetries}）`,
      }),
    })
    const baselinePartition = await run(baseline)
    onEvent({
      stage: partition === 'final' ? 'final-baseline' : 'final-feedback-baseline',
      message: `H0 已完成 ${partition} Partition`,
    })
    const candidatePartition = candidate.candidateId === baseline.candidateId
      ? baselinePartition : await run(candidate)
    for (const [id, record] of baselinePartition) baselineRecords.set(id, record)
    for (const [id, record] of candidatePartition) candidateRecords.set(id, record)
    onEvent({
      stage: partition === 'final' ? 'final-candidate' : 'final-feedback',
      message: `H0 与锁定 Champion 已完成 ${partition} Partition`,
    })
  }
  return { baselineRecords, candidateRecords }
}
