import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import test from 'node:test'

import { REPOSITORY_ROOT } from '../src/config.mjs'
import { snapshotTree, treeDigest } from '../src/candidate.mjs'
import { preparePopulationFork } from '../src/population-fork.mjs'

test('Fork 准备器只接受已登记、内容摘要匹配的 Parent Candidate', async () => {
  const root = await mkdtemp(join(REPOSITORY_ROOT, '.fork-fixture-'))
  const parentRoot = join(root, 'parent-run')
  const campaignId = basename(parentRoot)
  const branchRoot = join(parentRoot, 'branches', 'branch-001', 'run')
  const workspace = join(branchRoot, 'candidates', 'g001-l1', 'workspace')
  const checkpoint = join(parentRoot, 'public', 'checkpoints', 'budget-0004.json')
  try {
    await mkdir(workspace, { recursive: true })
    await writeFile(join(workspace, 'solver.py'), 'print("fixture")\n')
    const digest = treeDigest(await snapshotTree(workspace))
    await mkdir(join(parentRoot, 'public'), { recursive: true })
    await writeFile(join(parentRoot, 'public', 'state.json'), `${JSON.stringify({
      kind: 'PopulationCampaignState',
      campaignId,
      status: 'EVOLVING',
      branches: [{ branchId: 'branch-001' }],
      checkpoints: [{ requestedBudget: 4, path: 'public/checkpoints/budget-0004.json' }],
    })}\n`)
    await writeFile(join(branchRoot, 'state.json'), `${JSON.stringify({
      spec: {
        experimentPath: 'experiments/reasoning-msa-progressive-strict-smoke.json',
        candidates: [{ id: 'g001-l1', digest }],
      },
    })}\n`)
    await mkdir(join(parentRoot, 'public', 'checkpoints'), { recursive: true })
    await writeFile(checkpoint, `${JSON.stringify({
      kind: 'PopulationBudgetCheckpoint',
      campaignId,
      actualConsumedBudget: 4,
      branchIncumbents: [{
        branchId: 'branch-001',
        incumbent: { candidateId: 'g001-l1', digest },
      }],
    })}\n`)

    const prepared = await preparePopulationFork({
      repositoryRoot: REPOSITORY_ROOT,
      parentRunDirectory: parentRoot,
      runId: 'fork-fixture-001',
    })
    assert.equal(prepared.provenance.parentRunId, campaignId)
    assert.equal(prepared.provenance.parentConsumedBudget, 4)
    assert.equal(prepared.provenance.seeds['branch-001'].candidateId, 'g001-l1')
    assert.match(await readFile(join(prepared.experimentPath), 'utf8'), /reasoning-msa/u)

    await writeFile(join(workspace, 'solver.py'), 'print("tampered")\n')
    await assert.rejects(
      preparePopulationFork({
        repositoryRoot: REPOSITORY_ROOT,
        parentRunDirectory: parentRoot,
        runId: 'fork-fixture-002',
      }),
      /内容摘要不匹配/u,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
