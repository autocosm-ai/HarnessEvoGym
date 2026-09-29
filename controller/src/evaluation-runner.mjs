import { ProtocolError } from './protocol.mjs'

export const EVALUATION_RUNNER_VERSION = 'harness-rsi/evaluation-runner-v1'

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError(`${label} 必须是对象`)
  }
  return value
}

function candidateEntry(value, index) {
  const candidate = object(value, `Evaluation Candidate[${index}]`)
  if (typeof candidate.candidateId !== 'string' || candidate.candidateId.length === 0) {
    throw new ProtocolError(`Evaluation Candidate[${index}].candidateId 无效`)
  }
  if (typeof candidate.candidateDigest !== 'string' || candidate.candidateDigest.length === 0) {
    throw new ProtocolError(`Evaluation Candidate[${index}].candidateDigest 无效`)
  }
  if (candidate.candidateWorkspace !== undefined
      && (typeof candidate.candidateWorkspace !== 'string' || candidate.candidateWorkspace.length === 0)) {
    throw new ProtocolError(`Evaluation Candidate[${index}].candidateWorkspace 无效`)
  }
  return candidate
}

function validateEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new ProtocolError('Evaluation Candidates 必须是非空数组')
  }
  const normalized = entries.map(candidateEntry)
  if (new Set(normalized.map((entry) => entry.candidateId)).size !== normalized.length) {
    throw new ProtocolError('Evaluation Candidates 不能包含重复 Candidate')
  }
  return normalized
}

function validateResult(result, expectedInstanceIds, candidateId) {
  if (!(result instanceof Map)) throw new ProtocolError(`${candidateId} 的 Environment 结果必须是 Map`)
  if (!Array.isArray(expectedInstanceIds)) return result
  const expected = new Set(expectedInstanceIds)
  const actual = [...result.keys()]
  if (actual.length !== expected.size || actual.some((id) => !expected.has(id))) {
    throw new ProtocolError(`${candidateId} 的 ${expectedInstanceIds.length} 道题结果不完整，拒绝生成正式分数`)
  }
  return result
}

async function mapWithConcurrency(values, maximum, worker) {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 32) {
    throw new ProtocolError('Evaluation maximumConcurrency 必须是 1..32 的整数')
  }
  const output = new Array(values.length)
  let cursor = 0
  async function consume() {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= values.length) return
      output[index] = await worker(values[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(maximum, values.length) }, consume))
  return output
}

/**
 * 公共评测 Runner：Environment 负责题目执行/Checkpoint/Verifier，Runner 负责
 * Candidate 调度、完整性校验和统一重试参数。OfficeVal 与 HLE 都通过这个入口接入。
 */
export async function runEvaluationPartition({
  environment,
  candidates,
  partition,
  model,
  seeds,
  outputPath,
  expectedInstanceIds = null,
  infrastructureRetries = 0,
  retryReasoningOnly = false,
  strictFinalCheckpoints = false,
  maximumConcurrentTrials = null,
  maximumConcurrency = 1,
  onInfrastructureRetry = () => {},
  onCandidateComplete = () => {},
} = {}) {
  if (!environment || typeof environment.runCandidatePartition !== 'function') {
    throw new ProtocolError('Evaluation Environment 缺少 runCandidatePartition()')
  }
  if (typeof outputPath !== 'function') throw new ProtocolError('Evaluation outputPath 必须是函数')
  const entries = validateEntries(candidates)
  const results = await mapWithConcurrency(entries, maximumConcurrency, async (candidate) => {
    const result = await environment.runCandidatePartition({
      ...candidate,
      partition,
      model,
      seeds,
      outputPath: outputPath(candidate.candidateId, partition),
      infrastructureRetries,
      retryReasoningOnly,
      strictFinalCheckpoints,
      ...(maximumConcurrentTrials === null ? {} : { maximumConcurrentTrials }),
      onInfrastructureRetry: (event) => onInfrastructureRetry({
        ...event,
        candidateId: candidate.candidateId,
        partition,
      }),
    })
    const checked = validateResult(result, expectedInstanceIds, candidate.candidateId)
    await onCandidateComplete({ candidateId: candidate.candidateId, partition, result: checked })
    return [candidate.candidateId, checked]
  })
  return new Map(results)
}
