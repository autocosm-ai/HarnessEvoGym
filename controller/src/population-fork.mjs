import { realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { assertPathKind, resolveInside } from './config.mjs'
import { snapshotTree, treeDigest } from './candidate.mjs'
import { ProtocolError, readJsonFile } from './protocol.mjs'

function inside(root, path, label) {
  const rel = relative(root, path)
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new ProtocolError(`${label} 不能逃逸父 Run`)
}

async function canonicalInside(root, path, label, kind = 'directory') {
  await assertPathKind(path, label, kind)
  const actual = await realpath(path)
  inside(root, actual, label)
  return actual
}

/** 只读准备 Fork；不创建新 Run、不调用模型、不复制历史分数。 */
export async function preparePopulationFork({ repositoryRoot, parentRunDirectory, checkpointPath = null, experimentPath = null, runId }) {
  const repository = await realpath(repositoryRoot)
  const parentRoot = await canonicalInside(repository, resolve(parentRunDirectory), 'Parent Population Run')
  const state = await readJsonFile(join(parentRoot, 'public/state.json'))
  if (state.kind !== 'PopulationCampaignState' || state.campaignId !== basename(parentRoot)
      || !Array.isArray(state.branches) || state.branches.length === 0
      || !['EVOLVING', 'CLOSED', 'REPORTED', 'PAUSED_INFRASTRUCTURE'].includes(state.status)) {
    throw new ProtocolError('Parent 不是可用的 Population Run')
  }
  if (runId === state.campaignId) throw new ProtocolError('Fork 必须使用不同的 Run ID')
  const branchIds = state.branches.map((entry) => entry.branchId)
  if (branchIds.some((id) => !/^branch-[0-9]{3}$/u.test(id)) || new Set(branchIds).size !== branchIds.length) {
    throw new ProtocolError('Parent Branch ID 无效或重复')
  }
  const selected = checkpointPath ?? state.checkpoints?.at(-1)?.path
  if (typeof selected !== 'string') throw new ProtocolError('Parent 没有可用的 Budget Checkpoint')
  const checkpoint = await canonicalInside(parentRoot, resolve(parentRoot, selected), 'Fork Checkpoint', 'file')
  // 只接受已登记的稳定检查点；Parent 目前可以因后续步骤失败而暂停。
  if (!state.checkpoints?.some((entry) => resolve(parentRoot, entry.path) === checkpoint)) {
    throw new ProtocolError('Fork Checkpoint 尚未提交到 Parent 账本')
  }
  const value = await readJsonFile(checkpoint)
  if (value.kind !== 'PopulationBudgetCheckpoint' || value.campaignId !== state.campaignId
      || !Number.isSafeInteger(value.actualConsumedBudget) || value.actualConsumedBudget < 0
      || !Array.isArray(value.branchIncumbents) || value.branchIncumbents.length !== branchIds.length) {
    throw new ProtocolError('Fork Checkpoint 格式不完整')
  }
  const entries = new Map(value.branchIncumbents.map((entry) => [entry.branchId, entry]))
  if (entries.size !== branchIds.length || branchIds.some((id) => !entries.has(id))) {
    throw new ProtocolError('Fork Checkpoint Branch 集合不一致')
  }
  const seeds = {}
  let originalExperiment = null
  for (const branchId of branchIds) {
    const branchRoot = await canonicalInside(parentRoot, join(parentRoot, 'branches', branchId, 'run'), 'Fork Branch')
    const branchState = await readJsonFile(join(branchRoot, 'state.json'))
    originalExperiment ??= branchState.spec?.experimentPath
    const { candidateId, digest } = entries.get(branchId).incumbent ?? {}
    if (!/^[a-z0-9][a-z0-9._-]{1,119}$/u.test(candidateId ?? '') || !/^[a-f0-9]{64}$/u.test(digest ?? '')) {
      throw new ProtocolError('Fork Candidate 身份无效')
    }
    if (!branchState.spec?.candidates?.some((entry) => entry.id === candidateId && entry.digest === digest)) {
      throw new ProtocolError('Fork Candidate 不在 Parent Branch 的候选记录内')
    }
    const workspace = await canonicalInside(branchRoot, join(branchRoot, 'candidates', candidateId, 'workspace'), 'Fork Candidate')
    if (treeDigest(await snapshotTree(workspace)) !== digest) throw new ProtocolError('Fork Candidate 内容摘要不匹配')
    seeds[branchId] = { workspace, candidateId, digest }
  }
  const nextExperimentPath = await canonicalInside(repository,
    experimentPath === null ? resolveInside(repository, originalExperiment, 'Fork Experiment') : resolve(experimentPath),
    'Fork Experiment', 'file')
  return {
    experimentPath: nextExperimentPath,
    provenance: {
      parentRunId: state.campaignId,
      checkpoint: relative(repository, checkpoint).replaceAll('\\', '/'),
      parentConsumedBudget: value.actualConsumedBudget,
      seeds,
    },
  }
}

