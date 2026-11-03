import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { acquireCampaignLock } from './campaign-lock.mjs'
import { createEvaluationIdentity, compareEvaluationIdentity } from './evaluation-profile.mjs'
import { runEvaluationPartition } from './evaluation-runner.mjs'
import { snapshotTree, treeDigest } from './candidate.mjs'
import { ProtocolError } from './protocol.mjs'

const recordsDigest = (records) => createHash('sha256').update(JSON.stringify(records)).digest('hex')

async function save(path, value) {
  const temporary = `${path}.tmp-${randomUUID()}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  await rename(temporary, path)
}

export function evaluationStatistics(records, expectedIds, seeds) {
  if (!Array.isArray(records) || records.length !== expectedIds.length
      || new Set(records.map((r) => r.instanceId)).size !== expectedIds.length
      || records.some((r) => !expectedIds.includes(r.instanceId)
        || !Number.isFinite(r.reward) || !['resolved', 'unresolved'].includes(r.status)
        || !Array.isArray(r.trialRewards) || r.trialRewards.length !== seeds.length
        || r.trialRewards.some((v) => !Number.isFinite(v))
        || r.reward < 0 || r.reward > 1
        || Math.abs(r.reward - r.trialRewards.reduce((a, b) => a + b, 0) / seeds.length) > 1e-9
        || JSON.stringify(r.trialSeeds) !== JSON.stringify(seeds))) {
    throw new ProtocolError('评测记录缺题、重复、分数无效或 trial/seed 不完整')
  }
  const rawComplete = records.every((r) => r.scoreDetails?.metric === 'officeval-raw-ratio-v1' && Number.isFinite(r.scoreDetails.value))
  return { tasksCompleted: records.length, meanReward: records.reduce((sum, r) => sum + r.reward, 0) / records.length,
    rawMetric: rawComplete ? 'officeval-raw-ratio-v1' : null,
    rawMean: rawComplete ? records.reduce((sum, r) => sum + r.scoreDetails.value, 0) / records.length : null }
}

/** 公共会话负责身份、单写者锁和结果提交；Environment 负责题内执行及恢复。 */
export async function runEvaluationSession({
  outputRoot, candidates, environment, partition, model, seeds, expectedIds,
  identityInputs, resume = false, infrastructureRetries = 5, onEvent = () => {},
}) {
  if (!Array.isArray(candidates) || !candidates.length
      || candidates.some((c) => !/^[a-z0-9][a-z0-9._-]{0,119}$/u.test(c.candidateId))
      || new Set(candidates.map((c) => c.candidateId)).size !== candidates.length
      || !Array.isArray(seeds) || !seeds.length || seeds.some((s) => !Number.isSafeInteger(s))
      || new Set(seeds).size !== seeds.length) {
    throw new ProtocolError('评测候选和 seeds 必须非空、合法且唯一')
  }
  if (!Array.isArray(expectedIds) || !expectedIds.length || new Set(expectedIds).size !== expectedIds.length) {
    throw new ProtocolError('评测题目集合必须非空且唯一')
  }
  const identity = createEvaluationIdentity({ mode: 'exploratory', runId: basename(outputRoot), evaluation: {
    ...identityInputs, partition, model, seeds, infrastructureRetries,
    candidates: candidates.map(({ candidateId, candidateDigest, provenance }) => ({ candidateId, candidateDigest, provenance: provenance ?? null })),
    expectedIds,
  } })
  await mkdir(dirname(outputRoot), { recursive: true })
  const release = await acquireCampaignLock({ campaignsRoot: dirname(outputRoot), campaignId: basename(outputRoot), command: 'evaluate run' })
  try {
    if (!resume) {
      await mkdir(outputRoot, { recursive: false, mode: 0o700 })
      await save(join(outputRoot, 'identity.json'), identity)
    } else {
      const previous = JSON.parse(await readFile(join(outputRoot, 'identity.json'), 'utf8'))
      compareEvaluationIdentity(previous, identity, { mode: 'resume' })
    }
    const summary = { kind: 'EvaluationJobReport', mode: 'exploratory', identityDigest: identity.identityDigest,
      complete: false, metric: identityInputs.metric, candidates: {} }
    await mkdir(join(outputRoot, 'candidates'), { recursive: true, mode: 0o700 })
    for (const candidate of candidates) {
      const resultFile = join(outputRoot, 'candidates', `${candidate.candidateId}.json`)
      const item = { status: 'incomplete', tasksCompleted: 0, meanReward: null }
      summary.candidates[candidate.candidateId] = item
      try {
        if (treeDigest(await snapshotTree(candidate.candidateWorkspace)) !== candidate.candidateDigest) {
          throw new ProtocolError('候选在启动后发生变化')
        }
        let committed
        try { committed = JSON.parse(await readFile(resultFile, 'utf8')) } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
        if (committed) {
          if (committed.identityDigest !== identity.identityDigest || committed.recordsDigest !== recordsDigest(committed.records)) {
            throw new ProtocolError('候选评测身份或结果摘要不匹配')
          }
          Object.assign(item, evaluationStatistics(committed.records, expectedIds, seeds), { status: 'complete', reused: true })
        } else {
          const all = await runEvaluationPartition({ environment, candidates: [candidate], partition, model, seeds,
            expectedInstanceIds: expectedIds, infrastructureRetries,
            outputPath: (id) => join(outputRoot, `${id}-${partition}.jsonl`),
            onInfrastructureRetry: onEvent })
          const records = JSON.parse(JSON.stringify([...all.get(candidate.candidateId).values()]))
          const statistics = evaluationStatistics(records, expectedIds, seeds)
          if (treeDigest(await snapshotTree(candidate.candidateWorkspace)) !== candidate.candidateDigest) {
            throw new ProtocolError('评测修改了候选源码，拒绝提交结果')
          }
          await save(resultFile, { identityDigest: identity.identityDigest, recordsDigest: recordsDigest(records), records })
          Object.assign(item, statistics, { status: 'complete', reused: false })
        }
        onEvent({ stage: 'candidate-complete', candidateId: candidate.candidateId, ...item })
      } catch (error) {
        // 上游错误只保留类别；上游正文、任务内容和凭据不进入公共报告。
        item.error = { name: error.name ?? 'Error', code: error.failure?.code ?? error.code ?? null,
          category: error.failure?.category ?? null }
        onEvent({ stage: 'candidate-incomplete', candidateId: candidate.candidateId, error: item.error })
      }
      await save(join(outputRoot, 'summary.json'), summary)
    }
    summary.complete = Object.values(summary.candidates).every((item) => item.status === 'complete')
    await save(join(outputRoot, 'summary.json'), summary)
    return summary
  } finally { await release() }
}
