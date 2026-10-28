import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { readConfigFile, REPOSITORY_ROOT } from '../src/config.mjs'

const execute = promisify(execFile)

test('真实验收 dry-run 不创建 Run；拒绝一步 Office Solver 和缺失 B1 的配置', async (t) => {
  await mkdir(join(REPOSITORY_ROOT, '.rsi'), { recursive: true })
  const root = await mkdtemp(join(REPOSITORY_ROOT, '.rsi/acceptance-config-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const template = JSON.parse(await readFile(join(REPOSITORY_ROOT, 'experiments/cowork-msa-acceptance.json')))
  const recipe = await readConfigFile(join(REPOSITORY_ROOT, template.spec.recipe))
  const runId = `acceptance-config-${Date.now()}`
  const config = join(root, 'experiment.json')
  const invoke = () => execute(process.execPath, [join(REPOSITORY_ROOT, 'scripts/run-acceptance.mjs'),
    '--config', config, '--run-id', runId, '--dry-run'], { cwd: REPOSITORY_ROOT, timeout: 10_000 })

  await writeFile(config, JSON.stringify(template))
  const plan = JSON.parse((await invoke()).stdout)
  assert.equal(plan.dryRun, true)
  assert.equal(plan.budget, 2)
  assert.equal(plan.solverMaximumSteps, 12)
  assert.deepEqual(plan.partitions, { feedback: 1, selection: 1, final: 1 })

  const limited = structuredClone(template)
  limited.spec.adapters.target = 'adapters/targets/msa-minimal.yml'
  await writeFile(config, JSON.stringify(limited))
  await assert.rejects(invoke(), (error) => /完整 OfficeVal 验收不能使用.*maximumSteps/u.test(error.stderr))

  recipe.spec.checkpointing.budgetMilestones = [2]
  await writeFile(join(root, 'recipe.json'), JSON.stringify(recipe))
  template.spec.recipe = relative(REPOSITORY_ROOT, join(root, 'recipe.json'))
  await writeFile(config, JSON.stringify(template))
  await assert.rejects(invoke(), (error) => /包含 B1 检查点/u.test(error.stderr))
  for (const path of [join(REPOSITORY_ROOT, '.rsi/acceptance-results', runId),
    join(REPOSITORY_ROOT, '.rsi/runs/populations', runId)]) {
    await assert.rejects(access(path), { code: 'ENOENT' })
  }
})
