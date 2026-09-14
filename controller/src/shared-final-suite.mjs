import { mkdir, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { acquireCampaignLock } from './campaign-lock.mjs'
import { captureExecutionIdentity } from './execution-identity.mjs'
import { trustedControllerRevision } from './cowork-orchestrator.mjs'
import { evaluateBenchmark } from './evaluator.mjs'
import { inside, prepareFinalSuiteEntry } from './final-suite-entry.mjs'
import { digest, readOptionalJson, saveSuiteJson } from './final-suite-store.mjs'
import { ProtocolError, readJsonFile, readResultFile, validateResultRecords } from './protocol.mjs'
import { validateInfrastructureRetries } from './trial-infrastructure-retry.mjs'

const ID = /^[a-z0-9][a-z0-9_-]{0,79}$/u
export function validateSharedFinalConfig(value) {
  const allowed = new Set(['id', 'baselineFrom', 'populations', 'infrastructureRetries', 'retryReasoningOnly',
    'supersedeInterrupted', 'maximumConcurrentTrialsPerEntry'])
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((key) => !allowed.has(key))
      || typeof value.id !== 'string' || !ID.test(value.id)
      || typeof value.baselineFrom !== 'string' || !ID.test(value.baselineFrom)
      || !Array.isArray(value.populations) || value.populations.length < 1 || value.populations.length > 16) {
    throw new ProtocolError('Shared Final Suite 配置无效')
  }
  const labels = new Set(), roots = new Set()
  for (const entry of value.populations) {
    if (!entry || Object.keys(entry).some((key) => !['label', 'run'].includes(key))
        || typeof entry.label !== 'string' || !ID.test(entry.label) || entry.label === 'h0'
        || typeof entry.run !== 'string' || !entry.run || labels.has(entry.label) || roots.has(entry.run)) {
      throw new ProtocolError('Final Suite Population 标签或目录重复/非法')
    }
    labels.add(entry.label); roots.add(entry.run)
  }
  if (!labels.has(value.baselineFrom)) throw new ProtocolError('baselineFrom 必须指定列表中的固定 Population')
  const config = { infrastructureRetries: 5, retryReasoningOnly: false, supersedeInterrupted: false,
    maximumConcurrentTrialsPerEntry: 1, ...value }
  validateInfrastructureRetries(config.infrastructureRetries)
  if (typeof config.retryReasoningOnly !== 'boolean' || typeof config.supersedeInterrupted !== 'boolean') {
    throw new ProtocolError('Final Suite 开关必须是布尔值')
  }
  if (!Number.isSafeInteger(config.maximumConcurrentTrialsPerEntry)
      || config.maximumConcurrentTrialsPerEntry < 1 || config.maximumConcurrentTrialsPerEntry > 8) {
    throw new ProtocolError('每份 Final 并发必须为 1 到 8')
  }
  return config
}

export function assertSharedFinalCompatibility(entries) {
  const expected = digest(entries[0].compatibility)
  for (const entry of entries) {
    if (digest(entry.compatibility) !== expected) {
      throw new ProtocolError(`共享 H0 条件不一致：${entry.label}（模型/题目/Seed/资源/H0 必须相同）`)
    }
  }
  return expected
}

export async function executeSharedFinalJobs({ root, jobs, config, onEvent = () => {} }) {
  const records = new Map()
  await Promise.all(jobs.map(async (job) => {
    const path = join(root, 'jobs', `${job.label}.json`)
    const completionPath = join(root, 'completed', `${job.label}.json`)
    try {
      const completed = await readOptionalJson(completionPath)
      if (completed) {
        if (completed.outputPath !== job.outputPath || completed.candidateDigest !== job.candidate.candidateDigest) {
          throw new ProtocolError('Final 已完成任务身份不一致')
        }
        const raw = await readResultFile(job.outputPath)
        if (digest(raw) !== completed.recordsDigest) throw new ProtocolError('Final 已完成结果摘要不一致')
        records.set(job.label, validateResultRecords(raw, job.benchmark, 'final-suite/cached'))
        await saveSuiteJson(path, completed)
        return
      }
      await saveSuiteJson(path, { label: job.label, status: 'running', candidate: job.candidate,
        outputPath: job.outputPath, startedAt: new Date().toISOString() })
      onEvent({ stage: 'final-suite-start', message: `${job.label} 开始/继续隐藏题，已提交题不重跑` })
      const result = await job.environment.runCandidatePartition({
        ...job.candidate, partition: 'final', model: job.model, seeds: job.seeds,
        outputPath: job.outputPath, infrastructureRetries: config.infrastructureRetries,
        retryReasoningOnly: config.retryReasoningOnly, strictFinalCheckpoints: true,
        maximumConcurrentTrials: config.maximumConcurrentTrialsPerEntry,
        onInfrastructureRetry: ({ retry, maximumRetries }) => onEvent({
          stage: 'final-suite-retry', message: `${job.label} 当前题重试 ${retry}/${maximumRetries}（受持久化总预算限制）`,
        }),
      })
      // Environment 保证完整分区；再验证分母，绝不输出缺题平均数。
      const expected = job.benchmark.partitions.final.instanceIds
      if (result.size !== expected.length || expected.some((id) => !result.has(id))) {
        throw new ProtocolError('Final 结果缺题，不能生成完整分数')
      }
      const completedResult = { label: job.label, status: 'completed',
        candidateDigest: job.candidate.candidateDigest, outputPath: job.outputPath,
        recordsDigest: digest(await readResultFile(job.outputPath)), count: result.size, completedAt: new Date().toISOString() }
      await saveSuiteJson(completionPath, completedResult, { immutable: true })
      await saveSuiteJson(path, completedResult)
      records.set(job.label, result)
      onEvent({ stage: 'final-suite-completed', message: `${job.label} 已完成 ${result.size} 道隐藏题并评分` })
    } catch (error) {
      await saveSuiteJson(path, { label: job.label, status: 'failed', outputPath: job.outputPath,
        failure: { name: error.name, code: error.failure?.code ?? null }, failedAt: new Date().toISOString() })
      onEvent({ stage: 'final-suite-failed', message: `${job.label} 未完成；不生成零分或不完整平均分` })
    } finally { await job.stop() }
  }))
  return records
}

export async function runSharedFinalSuite({ repositoryRoot, configPath, resume = false, validateOnly = false, onEvent = () => {} }) {
  const config = validateSharedFinalConfig(await readJsonFile(configPath))
  const root = resolve(repositoryRoot, '.rsi/runs/final-suites', config.id)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const releases = [await acquireCampaignLock({ campaignsRoot: dirname(root), campaignId: config.id, command: 'final-suite' })]
  const entries = []
  try {
    const controllerRevision = await trustedControllerRevision(repositoryRoot)
    const execution = await captureExecutionIdentity(repositoryRoot)
    const populations = []
    for (const input of config.populations) {
      const populationRoot = inside(resolve(repositoryRoot, '.rsi/runs/populations'),
        await realpath(resolve(repositoryRoot, input.run)))
      if (populations.some((p) => p.populationRoot === populationRoot)) throw new ProtocolError('重复 Population 实际目录')
      populations.push({ ...input, populationRoot })
    }
    for (const population of [...populations].sort((a, b) => a.populationRoot.localeCompare(b.populationRoot))) {
      releases.push(await acquireCampaignLock({ campaignsRoot: dirname(population.populationRoot),
        campaignId: basename(population.populationRoot), command: 'final-suite' }))
    }
    const baselinePopulation = populations.find((p) => p.label === config.baselineFrom)
    for (const population of [{ ...baselinePopulation, label: 'h0' }, ...populations]) {
      onEvent({ stage: 'final-suite-preflight', message: `核验 ${population.label} 冻结版本、模型和环境` })
      entries.push(await prepareFinalSuiteEntry({ repositoryRoot, ...population,
        scopeId: `${config.id}-${population.label}`, supersedeInterrupted: config.supersedeInterrupted }))
    }
    const compatibilityDigest = assertSharedFinalCompatibility(entries)
    const claim = { kind: 'SharedFinalSuiteClaim', config, controllerRevision,
      executionDigest: execution.digest, compatibilityDigest,
      entries: entries.map((e) => ({ label: e.label, ...e.identity })) }
    const claimPath = join(root, 'claim.json')
    const existing = await readOptionalJson(claimPath)
    if (existing && !resume) throw new ProtocolError('Suite 已存在，只能用 --resume 继续同一份记录')
    if (!existing && resume) throw new ProtocolError('Suite 尚未开始，不能 Resume')
    if (existing && digest(existing) !== digest(claim)) throw new ProtocolError('Suite 冻结身份发生变化，拒绝 Resume')
    const adoption = { kind: 'FinalSuiteAdoption', suiteRoot: root, claimDigest: digest(claim) }
    // 先检查全部旧绑定，避免发现冲突时已经部分领取新权限。
    for (const population of populations) {
      const old = await readOptionalJson(join(population.populationRoot, 'final-suite-adoption.json'))
      if (old && digest(old) !== digest(adoption)) throw new ProtocolError('Population 已归入另一份 Final Suite')
    }
    if (validateOnly) return { root, status: 'validated', compatibilityDigest,
      candidates: entries.map((e) => ({ label: e.label,
        candidate: e.label === 'h0' ? e.baseline : e.champion })) }
    await saveSuiteJson(claimPath, claim, { immutable: true })
    for (const population of populations) {
      await saveSuiteJson(join(population.populationRoot, 'final-suite-adoption.json'), adoption, { immutable: true })
    }
    const jobs = entries.map((entry) => ({ ...entry,
      candidate: entry.label === 'h0' ? entry.baseline : entry.champion,
      outputPath: join(entry.runRoot, 'results', `shared-final-${config.id}`, `${entry.label}.jsonl`),
    }))
    await saveSuiteJson(join(root, 'plan.json'), { jobs: jobs.map((j) => ({ label: j.label,
      candidate: j.candidate, runRoot: j.runRoot, outputPath: j.outputPath })), config })
    await saveSuiteJson(join(root, 'state.json'), { status: 'running', startedAt: new Date().toISOString() })
    const records = await executeSharedFinalJobs({ root, jobs, config, onEvent })
    const rows = []
    for (const job of jobs.filter((j) => j.label !== 'h0')) {
      if (!records.has('h0') || !records.has(job.label)) {
        rows.push({ mode: job.label, candidate: job.candidate.candidateId, status: 'incomplete' }); continue
      }
      const report = evaluateBenchmark({ benchmark: job.benchmark, policy: job.policy,
        run: { id: `${config.id}-${job.label}`, baselineRevision: job.baseline.candidateDigest,
          candidateRevision: job.candidate.candidateDigest },
        baselineRecords: records.get('h0'), candidateRecords: records.get(job.label),
        partitions: ['final'], allowSealed: true, evolutionLedger: job.ledger })
      report.sharedBaseline = { suite: config.id, label: 'h0',
        recordsDigest: (await readOptionalJson(join(root, 'completed/h0.json'))).recordsDigest }
      await saveSuiteJson(join(root, 'reports', `${job.label}.json`), report, { immutable: true })
      const result = report.partitions.final
      rows.push({ mode: job.label, candidate: job.candidate.candidateId, status: 'completed',
        h0: result.baseline.meanReward, champion: result.candidate.meanReward, delta: result.paired.deltaMeanReward })
    }
    const summary = { status: records.size === jobs.length ? 'completed' : 'paused',
      config, rows, updatedAt: new Date().toISOString() }
    await saveSuiteJson(join(root, 'summary.json'), summary)
    await saveSuiteJson(join(root, 'state.json'), summary)
    return { root, ...summary }
  } finally {
    await Promise.all(entries.map((entry) => entry.stop().catch(() => {})))
    for (const release of releases.reverse()) await release()
  }
}
