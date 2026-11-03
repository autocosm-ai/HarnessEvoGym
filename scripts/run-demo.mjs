#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { REPOSITORY_ROOT } from '../controller/src/config.mjs'
import { resolveEvaluationCandidates } from '../controller/src/evaluation-candidates.mjs'
import { runEvaluationSession } from '../controller/src/evaluation-session.mjs'
import { createDemo, DemoEnvironment } from './demo-runtime.mjs'

const phase = process.argv[2] ?? 'all'
const root = resolve(process.argv[3] ?? join(REPOSITORY_ROOT, '.rsi', `demo-${Date.now()}`))
if (!root.startsWith(join(REPOSITORY_ROOT, '.rsi') + '/')) throw new Error('Demo 只能写入本仓库 .rsi 下的新目录')
if (phase === 'all') {
  for (const next of ['start', 'resume', 'evaluate']) {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), next, root], { stdio: 'inherit' })
    const code = await new Promise((done) => child.once('exit', done))
    if (code !== 0) process.exit(code ?? 1)
  }
  console.log(`离线示例完成。真实 Controller/检查点/评测；Solver 和 Updater 是明确的离线替身。结果：${relative(REPOSITORY_ROOT, root)}`)
} else {
  await mkdir(dirname(root), { recursive: true })
  const { orchestrator, benchmark } = await createDemo({ repositoryRoot: REPOSITORY_ROOT, root, initialize: phase === 'start' })
  if (phase === 'start') {
    await orchestrator.initialize()
    const state = await orchestrator.run({ roundLimit: 1 })
    if (state.budget.consumed !== 1 || !state.checkpoints.length) throw new Error('Demo 未保存第一轮检查点')
    console.log('第一个进程：已完成 1/2 轮并保存检查点，现在退出。')
  } else if (phase === 'resume') {
    const state = await orchestrator.resume()
    if (state.status !== 'CLOSED' || state.budget.consumed !== 2) throw new Error('Demo 恢复未完成')
    console.log('第二个进程：从检查点继续，已完成 2/2 轮。')
  } else if (phase === 'evaluate') {
    const population = join(root, 'populations/offline-demo')
    const candidates = await resolveEvaluationCandidates(root, [{ id: 'champion', run: 'populations/offline-demo' }])
    const outputRoot = join(root, 'evaluation')
    const report = await runEvaluationSession({ outputRoot, candidates,
      environment: new DemoEnvironment({ runRoot: outputRoot, benchmark }), partition: 'final',
      model: { model: 'offline-demo', reasoningEffort: 'none' }, seeds: [1],
      expectedIds: benchmark.partitions.final.instanceIds, identityInputs: { metric: 'offline-sum-correctness-v1' } })
    if (!report.complete || report.candidates.champion.meanReward !== 1) throw new Error('Demo 冠军未通过未见输入验证')
    const state = JSON.parse(await readFile(join(population, 'public/state.json'), 'utf8'))
    console.log(`第三个进程：冠军 ${state.best.candidateId} 在未见输入上通过。报告：${relative(REPOSITORY_ROOT, join(outputRoot, 'summary.json'))}`)
  } else throw new Error('Demo phase 必须为 all/start/resume/evaluate')
}
