#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, relative, resolve } from 'node:path'
import { REPOSITORY_ROOT, readConfigFile, resolveInside } from '../controller/src/config.mjs'
import { normalizeHleTextMathRow } from '../controller/src/hle-dataset.mjs'
import { buildHleSolverPrompt } from '../controller/src/hle-partition-runner.mjs'

const args = process.argv.slice(2)
const options = new Map()
for (let i = 0; i < args.length; i += 2) {
  if (!['--input', '--source', '--revision', '--output', '--per-partition'].includes(args[i]) || !args[i + 1]) {
    throw new Error('用法：prepare-hle-docker --input <eligible.jsonl> --source <数据源> --revision <版本> --output <.rsi/目录> [--per-partition 1]')
  }
  options.set(args[i], args[i + 1])
}
for (const key of ['--input', '--source', '--revision', '--output']) if (!options.has(key)) throw new Error(`缺少 ${key}`)
const count = Number(options.get('--per-partition') ?? 1)
if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('每个分区题数必须为 1..100')
const destination = resolveInside(REPOSITORY_ROOT, options.get('--output'), 'HLE 输出')
if (!relative(REPOSITORY_ROOT, destination).startsWith('.rsi/')) throw new Error('HLE 私有数据必须放在 .rsi 内')
const input = await readFile(resolve(options.get('--input')), 'utf8')
const hash = (v) => createHash('sha256').update(v).digest('hex')
const rows = input.trim().split('\n').map((line, i) => normalizeHleTextMathRow(JSON.parse(line), i))
  .sort((a, b) => hash(a.sourceId).localeCompare(hash(b.sourceId)))
if (rows.length < 3 * count || new Set(rows.map((r) => r.sourceId)).size !== rows.length) throw new Error('题目不足或 ID 重复')
const instances = []
for (const [index, partition] of ['feedback', 'selection', 'final'].entries()) {
  for (const row of rows.slice(index * count, (index + 1) * count)) {
    instances.push({ id: `hle_${hash(row.sourceId).slice(0, 24)}`, partition,
      instruction: buildHleSolverPrompt(row), answer: row.answer })
  }
}
await mkdir(destination, { recursive: false, mode: 0o700 })
const path = (name) => relative(REPOSITORY_ROOT, join(destination, name)).replaceAll('\\', '/')
const write = (name, value) => writeFile(join(destination, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
const tasks = { apiVersion: 'harness-rsi/v1alpha1', kind: 'HleTextMathTasks',
  metadata: { id: 'hle-local-acceptance', notice: `工程验收数据；来源 ${options.get('--source')}@${options.get('--revision')}，不宣称与原官方固定版本等价。` }, instances }
await write('tasks.json', tasks)
const revision = hash(await readFile(join(destination, 'tasks.json')))
const benchmark = await readConfigFile(join(REPOSITORY_ROOT, 'benchmarks/text-reasoning-smoke/benchmark.json'))
benchmark.metadata = { id: 'hle-docker-acceptance', name: 'HLE text-only Math Docker acceptance' }
benchmark.spec.source = { ...benchmark.spec.source, adapter: 'hle-text-math-docker', dataset: options.get('--source'), revision,
  split: 'disjoint-feedback-selection-final' }
benchmark.spec.evaluator.adapter = 'hle-text-math-docker'
benchmark.spec.expectedTotal = instances.length
for (const [partition, spec] of Object.entries(benchmark.spec.partitions)) {
  spec.instanceIds = instances.filter((t) => t.partition === partition).map((t) => t.id)
  spec.expectedCount = spec.instanceIds.length
}
await write('benchmark.json', benchmark)
const environment = await readConfigFile(join(REPOSITORY_ROOT, 'environments/text-reasoning-smoke.yml'))
environment.metadata = { id: 'hle-text-math-docker', name: 'HLE Text Math with trusted LLM Judge' }
environment.spec.protocol = 'hle-text-math-docker-v1'
environment.spec.source = { tasksPath: path('tasks.json'), digest: revision }
environment.spec.judge = { model: 'gpt-6.1-sol', reasoningEffort: 'medium', maxTokens: 2048, timeoutSeconds: 120 }
environment.spec.docker.resources.timeoutSeconds = 600
await write('environment.json', environment)
const recipe = await readConfigFile(join(REPOSITORY_ROOT, 'recipes/population-smoke/single.yml'))
recipe.spec.population.budget.total_budget = 2
recipe.spec.checkpointing = { budgetMilestones: [1, 2], branchGenerationMilestones: [],
  capture: { populationBest: true, branchIncumbents: true, latestAttempts: true } }
await write('recipe.json', recipe)
const experiment = await readConfigFile(join(REPOSITORY_ROOT, 'experiments/reasoning-msa-smoke-single.json'))
experiment.metadata.id = 'hle-docker-acceptance'
experiment.spec.recipe = path('recipe.json')
experiment.spec.adapters.environment = path('environment.json')
experiment.spec.benchmark = path('benchmark.json')
experiment.spec.models.solver.maxTokens = 8192
await write('experiment.json', experiment)
await write('source.json', { source: options.get('--source'), revision: options.get('--revision'), inputSha256: hash(input),
  availableTasks: rows.length, selectedTasks: instances.length, sampling: 'sha256(sourceId)-ascending', officialPinnedRevisionVerified: false })
console.log(JSON.stringify({ experiment: path('experiment.json'), tasks: instances.length }))
