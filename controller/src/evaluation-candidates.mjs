import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { snapshotTree, treeDigest } from './candidate.mjs'
import { ProtocolError, readJsonFile } from './protocol.mjs'

export function evaluationInside(root, path, label = '评测路径') {
  const rel = relative(root, path)
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new ProtocolError(`${label} 不能逃逸配置目录范围`)
  return path
}

export async function evaluationPath(root, value, label, kind = 'directory') {
  if (typeof value !== 'string' || !value || isAbsolute(value)) throw new ProtocolError(`${label} 必须是相对路径`)
  const path = evaluationInside(root, resolve(root, value), label)
  const stat = await lstat(path)
  if (stat.isSymbolicLink() || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())) {
    throw new ProtocolError(`${label} 类型无效`)
  }
  return evaluationInside(root, await realpath(path), label)
}

/** 接受独立只读工作区、训练冠军或已提交的预算检查点；绝不按测试成绩选版本。 */
export async function resolveEvaluationCandidates(repositoryRoot, entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 128) throw new ProtocolError('评测候选数量必须为 1..128')
  const seen = new Set()
  const root = await realpath(repositoryRoot)
  const candidates = []
  for (const item of entries) {
    if (!item || !/^[a-z0-9][a-z0-9._-]{0,119}$/u.test(item.id) || seen.has(item.id)
        || Object.keys(item).some((key) => !['id', 'workspace', 'run', 'checkpoint'].includes(key))
        || Boolean(item.workspace) === Boolean(item.run) || (item.checkpoint && !item.run)) {
      throw new ProtocolError('评测候选必须有唯一 id，并选择 workspace 或 run')
    }
    seen.add(item.id)
    let workspace, expectedDigest, provenance
    if (item.workspace) {
      workspace = await evaluationPath(root, item.workspace, 'Candidate workspace')
      provenance = { workspace: item.workspace }
    } else {
      const runRoot = await evaluationPath(root, item.run, 'Candidate run')
      let branchRoot = runRoot
      let selected
      let population
      let stateFile
      try { stateFile = await lstat(join(runRoot, 'public/state.json')) } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      if (stateFile) population = await readJsonFile(join(runRoot, 'public/state.json'))
      if (population) {
        if (population.kind !== 'PopulationCampaignState') throw new ProtocolError('未知 Population 状态')
        selected = population.best
        if (item.checkpoint) {
          const checkpointPath = await evaluationPath(runRoot, item.checkpoint, 'Candidate checkpoint', 'file')
          if (!population.checkpoints?.some((entry) => resolve(runRoot, entry.path) === checkpointPath)) {
            throw new ProtocolError('只能评测已经提交的预算检查点')
          }
          const checkpoint = await readJsonFile(checkpointPath)
          if (checkpoint.kind !== 'PopulationBudgetCheckpoint' || checkpoint.campaignId !== population.campaignId) {
            throw new ProtocolError('检查点所属 Run 不一致')
          }
          selected = checkpoint.populationBest
        }
        if (!/^branch-[0-9]{3}$/u.test(selected?.branchId)) throw new ProtocolError('检查点缺少合法冠军 Branch')
        branchRoot = await evaluationPath(runRoot, `branches/${selected.branchId}/run`, 'Candidate branch')
      } else if (item.checkpoint) throw new ProtocolError('预算检查点只适用于 Population')
      const state = await readJsonFile(join(branchRoot, 'state.json'))
      if (state.kind !== 'EvolutionRunState') throw new ProtocolError('此评测入口需要 EvolutionRunState 候选')
      const candidateId = selected?.candidateId ?? state.spec?.championId
      if (!/^[a-z0-9][a-z0-9._-]{0,119}$/u.test(candidateId ?? '')) throw new ProtocolError('训练冠军 ID 无效')
      const candidate = state.spec?.candidates?.find((entry) => entry.id === candidateId)
      if (!candidate || !['baseline', 'promoted'].includes(candidate.status)) throw new ProtocolError('冠军没有已提交的晋升记录')
      expectedDigest = candidate.digest
      if (selected?.digest && selected.digest !== expectedDigest) throw new ProtocolError('检查点与候选摘要不一致')
      workspace = await evaluationPath(branchRoot, `candidates/${candidateId}/workspace`, 'Champion workspace')
      provenance = { run: item.run, checkpoint: item.checkpoint ?? null, candidateId }
    }
    const candidateDigest = treeDigest(await snapshotTree(workspace))
    if (expectedDigest && expectedDigest !== candidateDigest) throw new ProtocolError('候选代码与训练记录不一致')
    candidates.push({ candidateId: item.id, candidateDigest, candidateWorkspace: workspace, provenance })
  }
  return candidates
}
