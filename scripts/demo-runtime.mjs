import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { loadExperimentBundle } from '../controller/src/adapters.mjs'
import { copyRegularTree, writeJsonLines } from '../controller/src/candidate.mjs'
import { capturePopulationBundle, createCoworkBranchEvolutionDriver } from '../controller/src/cowork-orchestrator.mjs'
import { normalizeEvolutionRecipe } from '../controller/src/evolution-recipe.mjs'
import { PopulationOrchestrator } from '../controller/src/population-orchestrator.mjs'
import { stageUpdaterContext } from '../controller/src/runtimes/dsh.mjs'
import { validateResultRecords } from '../controller/src/protocol.mjs'
import { runProcess } from '../controller/src/process.mjs'
import { inspectTrialCheckpoint, commitTrialCheckpoint } from '../controller/src/trial-checkpoint-store.mjs'

const digest = (value) => createHash('sha256').update(value).digest('hex')
const tasks = Object.freeze({ feedback: [2, 5], selection: [7, 11], final: [13, 17] })
const initialProgram = `import argparse,json
from pathlib import Path
p=argparse.ArgumentParser()
p.add_argument('--numbers');p.add_argument('--answer')
a=p.parse_args()
numbers=json.loads(a.numbers)
Path(a.answer).write_text(str(sum(numbers) + 1))
`

function usage(count = 0) {
  return { complete: true, requests: count, usageResponses: count, unknownUsageResponses: 0,
    inputTokens: 0, outputTokens: 0, totalTokens: 0, observedInputTokens: 0, observedOutputTokens: 0,
    cacheReadTokens: 0, reasoningTokens: 0 }
}

/** 只执行仓库内受信示例；不接受外部 Candidate，不宣称提供 OS 沙箱。 */
export class DemoEnvironment {
  constructor({ runRoot, benchmark }) { this.runRoot = runRoot; this.benchmark = benchmark }
  async preflight() { return { sourceRevision: digest(JSON.stringify(tasks)) } }
  async ensureRuntime() { return {} }
  async taskLayout(instanceId) { return { instanceId } }
  async runCandidatePartition({ candidateId, candidateDigest, candidateWorkspace, partition, seeds, outputPath }) {
    const id = this.benchmark.partitions[partition].instanceIds[0]
    const root = join(this.runRoot, 'demo-trials', digest(outputPath).slice(0, 12), candidateId, partition)
    const identity = { candidateDigest, partition, seeds }
    const old = await inspectTrialCheckpoint({ runRoot: this.runRoot, taskRoot: root, identity,
      validateRecord: (record) => { validateResultRecords([record], this.benchmark, 'demo'); return record } })
    let record
    if (old.status === 'committed') record = old.record
    else {
      await mkdir(root, { recursive: true })
      const values = []
      for (const seed of seeds) {
        const path = join(root, `answer-${seed}.txt`)
        await runProcess('python3', [join(candidateWorkspace, 'run.py'), '--numbers', JSON.stringify(tasks[partition]), '--answer', path],
          { timeoutMs: 10000, cwd: root, env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' } })
        values.push(Number(await readFile(path, 'utf8')) === tasks[partition].reduce((a, b) => a + b) ? 1 : 0)
      }
      const reward = values.reduce((a, b) => a + b) / values.length
      record = { instance_id: id, status: reward === 1 ? 'resolved' : 'unresolved', reward,
        trial_rewards: values, trial_seeds: seeds, input_tokens: 0, output_tokens: 0, latency_ms: 0,
        policy_violations: [], ...(partition === 'feedback' ? { feedback: { verifierFeedback: '输出比输入之和多了 1，请检查通用求和逻辑。' } } : {}) }
      await commitTrialCheckpoint({ runRoot: this.runRoot, taskRoot: root, identity, record })
    }
    await writeJsonLines(outputPath, [record])
    return validateResultRecords([record], this.benchmark, 'demo')
  }
}

export async function createDemo({ repositoryRoot, root, initialize = false, onEvent = () => {} }) {
  const seedRoot = join(root, 'seed')
  if (initialize) {
    await mkdir(root, { recursive: false })
    await mkdir(join(root, 'populations'))
    await copyRegularTree(join(repositoryRoot, 'targets/msa-minimal/cowork-v1'), seedRoot)
    await writeFile(join(seedRoot, 'tools.py'), '"""离线示例无需模型工具。"""\n')
    await writeFile(join(seedRoot, 'run.py'), initialProgram)
  }
  const bundle = await loadExperimentBundle(join(repositoryRoot, 'experiments/cowork-msa-smoke-single.json'), repositoryRoot)
  bundle.updater.runtime = { secretEnvironment: [] }
  bundle.updater.source = null
  bundle.experiment.baselinePack = null
  bundle.experimentPath = 'demo-experiment.json'
  bundle.target.materialization = { ...bundle.target.materialization, protocol: 'controller-owned-overlay-v1', baselinePath: 'seed' }
  bundle.environment.task.environmentAssets = null
  bundle.policy.bootstrap.samples = 100
  bundle.benchmark = (await loadExperimentBundle(join(repositoryRoot, 'experiments/reasoning-msa-smoke-single.json'), repositoryRoot)).benchmark
  bundle.recipe = normalizeEvolutionRecipe({ apiVersion: 'harness-rsi/v1alpha1', kind: 'EvolutionRecipe', spec: {
    population: { mode: 'single', concurrency: { n_branches: 1 }, budget: { total_budget: 2, beta: 0 },
      peer_sharing: { enabled: false }, competition: { enabled: false, bonus_grant_unit: 1 } },
    moduleSearch: { authority: 'updater-directed', riskCeiling: 'l3', strategy: null },
    checkpointing: { budgetMilestones: [1, 2], branchGenerationMilestones: [],
      capture: { populationBest: true, branchIncumbents: true, latestAttempts: true } },
  } })
  // 假凭据仅用于满足真实 Controller 的运行契约；示例不调用模型、不访问网络。
  process.env.RSI_PROVIDER_API_KEY = 'offline-demo-no-real-secret'
  process.env.RSI_PROVIDER_BASE_URL = 'http://127.0.0.1:1'
  if (initialize) {
    await mkdir(join(root, 'prompts'))
    await writeFile(join(root, bundle.updater.promptPath), await readFile(join(repositoryRoot, bundle.updater.promptPath)))
  }
  const frozen = await capturePopulationBundle(bundle, root)
  const contextFactory = async () => ({ bundle, sourceRoot: seedRoot, targetSourceRoot: seedRoot,
    sourceRevision: bundle.target.source.revision, targetSourceRevision: bundle.target.source.revision,
    updaterSourceRevision: 'd'.repeat(64), absoluteExperimentPath: join(root, 'demo-experiment.json'),
    docker: {}, solverDriver: { usage }, modelGateway: { async stop() { return [] } },
    searchStrategy: { async preflight() {}, descriptor() { return { id: 'offline-demo' } } },
    updaterDriver: {
      async ensureRuntime() {}, stageContext: stageUpdaterContext, usage,
      async run({ candidateWorkspace }) {
        const path = join(candidateWorkspace, 'run.py')
        const source = await readFile(path, 'utf8')
        await writeFile(path, source.includes('sum(numbers) + 1') ? source.replace('sum(numbers) + 1', 'sum(numbers)') : source + '\n# 离线示例：第二轮不改变算法。\n')
        return { stdout: '', stderr: '', report: { diagnosis: '反馈显示求和结果多 1。',
          hypothesis: '去掉通用求和逻辑的额外常数。', changedFiles: ['run.py'],
          expectedImpact: '让不同输入的求和都正确。', remainingRisks: '预设离线替身，不代表真实模型能力提升。' } }
      },
    },
  })
  const orchestrator = new PopulationOrchestrator({
    loadedCampaign: { config: frozen.snapshot, recipe: bundle.recipe, configDigest: frozen.digest, fingerprint: frozen.digest },
    campaignsRoot: join(root, 'populations'), campaignId: 'offline-demo', frozenConfig: frozen.snapshot,
    progress: onEvent,
    createBranch: ({ branchId, branchesRoot }) => createCoworkBranchEvolutionDriver({ repositoryRoot: root,
      experimentPath: join(root, 'demo-experiment.json'), runId: `demo-${branchId}`, branchId,
      runRootOverride: join(branchesRoot, branchId, 'run'), expectedBundleDigest: frozen.digest },
    { contextFactory, environmentFactory: (options) => new DemoEnvironment(options), controllerRevisionReader: async () => 'd'.repeat(40) }),
  })
  return { orchestrator, benchmark: bundle.benchmark }
}
