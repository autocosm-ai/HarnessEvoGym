#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { REPOSITORY_ROOT } from '../controller/src/config.mjs'
import { loadExperimentBundle } from '../controller/src/adapters.mjs'

// 显式调用才会消耗模型费用；普通 npm test 不运行本脚本。
const args = process.argv.slice(2)
const dryRun = args.at(-1) === '--dry-run'
if (dryRun) args.pop()
if (args.length !== 4 || args[0] !== '--config' || args[2] !== '--run-id' || !/^[a-z0-9][a-z0-9.-]{2,80}$/u.test(args[3])) {
  throw new Error('用法：npm run test:acceptance -- --config <experiment.json> --run-id <新的唯一ID> [--dry-run]')
}
const config = resolve(REPOSITORY_ROOT, args[1]), runId = args[3]
const bundle = await loadExperimentBundle(config, REPOSITORY_ROOT)
if (bundle.recipe.spec.population.concurrency.n_branches !== 1 || bundle.recipe.spec.population.budget.total_budget !== 2
    || !bundle.recipe.spec.checkpointing?.budgetMilestones.includes(1)) {
  throw new Error('真实验收配置必须为单 Branch、预算 2、包含 B1 检查点')
}
const solverMaximumSteps = bundle.target.solver.runtime?.maximumSteps ?? null
if (bundle.environment.protocol === 'omegause-officeval-docker-v1'
    && bundle.target.solver.protocol === 'msa-minimal-docker-v1' && solverMaximumSteps === 1) {
  throw new Error('完整 OfficeVal 验收不能使用 maximumSteps=1 的连通性配置；请使用 adapters/targets/msa-minimal-cowork-rsi.yml')
}
const partitions = Object.fromEntries(['feedback', 'selection', 'final']
  .map((partition) => [partition, bundle.benchmark.partitions[partition].instanceIds.length]))
if (Object.values(partitions).some((count) => count === 0)) {
  throw new Error('真实验收需要非空的 feedback、selection 和 final 分区')
}
if (dryRun) {
  console.log(JSON.stringify({ kind: 'LiveAcceptancePlan', dryRun: true, runId,
    experiment: relative(REPOSITORY_ROOT, config), budget: 2, solverMaximumSteps, partitions }))
  process.exit(0)
}
const root = join(REPOSITORY_ROOT, '.rsi/acceptance-results', runId)
await mkdir(join(root, '..'), { recursive: true })
await mkdir(root, { recursive: false, mode: 0o700 })
const save = (name, value) => writeFile(join(root, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })

async function cli(stage, command) {
  const child = spawn(process.execPath, [join(REPOSITORY_ROOT, 'controller/src/cli.mjs'), ...command], {
    cwd: REPOSITORY_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk; process.stderr.write(chunk) })
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done) })
  await writeFile(join(root, `${stage}.log`), stderr + '\n' + stdout, { mode: 0o600, flag: 'wx' })
  if (code !== 0) throw new Error(`${stage} 失败；已保留日志和运行检查点，退出码 ${code}`)
  return JSON.parse(stdout)
}

const first = await cli('start', ['experiment', 'run', '--config', config, '--run-id', runId, '--round-limit', '1'])
const before = JSON.parse(await readFile(join(first.runRoot, 'public/state.json'), 'utf8'))
if (before.budget.consumed !== 1 || !before.checkpoints.length) throw new Error('未得到 B1 稳定检查点')
const resumed = await cli('resume', ['experiment', 'resume', '--run', first.runRoot])
if (resumed.status !== 'CLOSED') throw new Error('恢复后未正常关闭训练')
const after = JSON.parse(await readFile(join(first.runRoot, 'public/state.json'), 'utf8'))
if (after.budget.consumed !== 2) throw new Error('恢复后预算重复扣除或未完成')
const evaluationConfig = { apiVersion: 'harness-rsi/v1alpha1', kind: 'EvaluationJob', spec: {
  mode: 'exploratory', experiment: relative(REPOSITORY_ROOT, config), partition: 'final',
  candidates: [{ id: 'champion', run: relative(REPOSITORY_ROOT, first.runRoot) }],
  output: relative(REPOSITORY_ROOT, join(root, 'evaluation')), infrastructureRetries: 5,
} }
await save('evaluation.json', evaluationConfig)
const final = await cli('evaluate', ['evaluate', 'run', '--config', join(root, 'evaluation.json')])
const repeat = await cli('evaluate-resume', ['evaluate', 'run', '--config', join(root, 'evaluation.json'), '--resume'])
if (!final.complete || !repeat.candidates.champion.reused) throw new Error('冠军评测或已完成结果复用失败')
await save('acceptance.json', { kind: 'LiveAcceptanceReport', runId, runRoot: relative(REPOSITORY_ROOT, first.runRoot),
  budgetBeforeResume: 1, budgetAfterResume: 2, championId: resumed.championId, checkpoint: before.checkpoints[0],
  final, evaluationReused: true, completedAt: new Date().toISOString() })
console.log(JSON.stringify({ runId, complete: true, report: relative(REPOSITORY_ROOT, join(root, 'acceptance.json')) }))
