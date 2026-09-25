import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import {
  assertCandidateIntegrity, assertPopulationBundleMatches, createContext, jsonDigest,
  loadPopulationFinalAuthorization, publicBundleSnapshot, stopContextModelGateways,
} from './cowork-orchestrator.mjs'
import { createEnvironmentRunner } from './factories.mjs'
import { supportsTaskInfrastructureRetries } from './environment-capabilities.mjs'
import { captureRuntimeInputs } from './execution-identity.mjs'
import { ProtocolError, readJsonFile } from './protocol.mjs'
import { digest, readOptionalJson } from './final-suite-store.mjs'

export function inside(root, path) {
  const rel = relative(root, path)
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new ProtocolError('Final Suite 路径逃逸')
  return path
}

// 只消费已关闭 Population 锁定的 Champion；不允许指定任意 Candidate 或根据测试选版本。
export async function prepareFinalSuiteEntry({ repositoryRoot, populationRoot, label, scopeId,
  supersedeInterrupted }) {
  const population = await loadPopulationFinalAuthorization({ repositoryRoot, populationRoot, sharedSuite: true })
  const state = population.branchState
  if (population.state.final && !supersedeInterrupted) {
    throw new ProtocolError('旧 Final 已尝试，必须显式声明 supersedeInterrupted 并保留原记录')
  }
  const claimFiles = {}
  for (const name of ['final-attempt.json', 'final-recovery-attempt.json']) {
    const value = await readOptionalJson(join(populationRoot, name))
    if (value !== null) claimFiles[name] = digest(value)
  }
  // 不允许与旧 finalize 同时写同一个 Branch 的 Trial。
  const { readdir } = await import('node:fs/promises')
  for (const pid of await readdir('/proc')) {
    if (!/^\d+$/u.test(pid) || Number(pid) === process.pid) continue
    const command = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')
    if (command.includes('experiment\0finalize\0') && command.includes(`${populationRoot}\0`)) {
      throw new ProtocolError('旧 Final 进程尚未停止')
    }
  }
  const context = await createContext({
    repositoryRoot,
    experimentPath: inside(repositoryRoot, resolve(repositoryRoot, state.spec.experimentPath)),
    runRootOverride: population.runRoot,
    gatewayScope: scopeId,
  })
  const { bundle } = context
  if (bundle.benchmark.finalEvaluation === 'disabled') throw new ProtocolError('Benchmark 禁止 Final')
  if (context.targetSourceRevision !== state.spec.targetSourceRevision
      || context.updaterSourceRevision !== state.spec.updaterSourceRevision) {
    throw new ProtocolError('Source 与进化冻结版本不一致')
  }
  const snapshot = await readJsonFile(join(population.runRoot, 'experiment.snapshot.json'))
  if (jsonDigest(snapshot) !== state.spec.configDigest
      || jsonDigest(publicBundleSnapshot(bundle)) !== state.spec.configDigest) {
    throw new ProtocolError('Experiment/Benchmark/模型/Policy 已在进化后变更')
  }
  await assertPopulationBundleMatches({ bundle, repositoryRoot, expectedDigest: population.state.configDigest })
  const environment = createEnvironmentRunner({
    repositoryRoot, environment: bundle.environment, benchmark: bundle.benchmark,
    target: bundle.target, solverDriver: context.solverDriver, docker: context.docker,
    runRoot: population.runRoot,
  })
  if (!supportsTaskInfrastructureRetries(environment)) throw new ProtocolError('Environment 不支持按题恢复')
  const preflight = await environment.preflight()
  if (preflight.sourceRevision !== state.spec.benchmarkSourceRevision) throw new ProtocolError('Benchmark Source 漂移')
  await environment.ensureRuntime()
  const frozen = new Map(state.spec.candidates.map((entry) => [entry.id, entry]))
  if (frozen.size !== state.spec.candidates.length) throw new ProtocolError('重复 Candidate ID')
  async function candidate(id, baseline = false) {
    const entry = frozen.get(id)
    if (!entry || (baseline ? entry.status !== 'baseline' : !['baseline', 'promoted'].includes(entry.status))) {
      throw new ProtocolError('Candidate 未冻结或未晋升')
    }
    const root = inside(population.runRoot, resolve(population.runRoot, 'candidates', id))
    const workspace = inside(root, await realpath(join(root, 'workspace')))
    const manifest = await readJsonFile(join(root, 'manifest.json'))
    await assertCandidateIntegrity({
      candidateId: id, workspace, manifest, expectedDigest: entry.digest,
      sourceRevision: context.sourceRevision, ...bundle.target.mutation.limits, label,
    })
    return { candidateId: id, candidateDigest: entry.digest, candidateWorkspace: workspace }
  }
  const baseline = await candidate(state.spec.baselineId, true)
  const champion = await candidate(state.spec.championId)
  const runtime = await captureRuntimeInputs(bundle)
  return {
    label, populationRoot, runRoot: population.runRoot, baseline, champion, environment,
    benchmark: bundle.benchmark, policy: bundle.policy, model: bundle.experiment.models.solver,
    seeds: state.spec.seeds, ledger: state.spec.ledger ?? null,
    identity: {
      populationRoot, branchId: population.branchId, configDigest: state.spec.configDigest,
      populationConfigDigest: population.state.configDigest,
      baseline, champion, priorFinal: population.state.final ?? null, claimFiles, runtime,
      evolutionControllerRevision: state.spec.controllerRevision,
    },
    compatibility: {
      h0Digest: baseline.candidateDigest, target: bundle.target,
      benchmark: publicBundleSnapshot(bundle).benchmark, policy: bundle.policy,
      environment: bundle.environment, runtimeRevision: environment.runtimeRevision,
      runtimeIdentity: environment.runtimeIdentity,
      solverCacheKey: context.solverDriver.cacheKey ?? null,
      model: bundle.experiment.models.solver, provider: bundle.providers.solver,
      endpoint: runtime.providerEndpoints.solver, seeds: state.spec.seeds,
    },
    stop: () => stopContextModelGateways(context),
  }
}
