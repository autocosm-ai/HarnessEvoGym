import { mkdir, realpath, lstat } from 'node:fs/promises'
import { basename, dirname, join, resolve, relative } from 'node:path'
import { loadExperimentBundle } from './adapters.mjs'
import { readConfigFile, resolveInside } from './config.mjs'
import { resolveEvaluationCandidates, evaluationInside, evaluationPath } from './evaluation-candidates.mjs'
import { runEvaluationSession } from './evaluation-session.mjs'
import { DockerClient } from './docker.mjs'
import { ModelGateway, validateModelGatewayEnvironment } from './cowork-model-gateway.mjs'
import { createEnvironmentRunner, createSolverDriver } from './factories.mjs'
import { captureExecutionIdentity, captureRuntimeInputs } from './execution-identity.mjs'
import { ProtocolError } from './protocol.mjs'
import { finalizeEvolution } from './cowork-orchestrator.mjs'

function validateRequest(input) {
  if (!input || input.kind !== 'EvaluationJob' || input.apiVersion !== 'harness-rsi/v1alpha1'
      || !input.spec || !['exploratory', 'sealed-final'].includes(input.spec.mode)) {
    throw new ProtocolError('需要声明 EvaluationJob 与 exploratory/sealed-final 模式')
  }
  const spec = input.spec
  const allowed = spec.mode === 'sealed-final' ? ['mode', 'run']
    : ['mode', 'experiment', 'candidates', 'partition', 'output', 'model', 'seeds', 'infrastructureRetries']
  if (Object.keys(spec).some((key) => !allowed.includes(key))) throw new ProtocolError('评测配置含未知或该模式禁止的字段')
  if (spec.mode === 'sealed-final') return spec
  if (!['feedback', 'selection', 'final'].includes(spec.partition)) throw new ProtocolError('评测 partition 无效')
  if (spec.seeds !== undefined && (!Array.isArray(spec.seeds) || !spec.seeds.length || spec.seeds.length > 64
      || spec.seeds.some((v) => !Number.isSafeInteger(v)) || new Set(spec.seeds).size !== spec.seeds.length)) {
    throw new ProtocolError('评测 seeds 必须是非空且唯一的整数数组')
  }
  const retries = spec.infrastructureRetries ?? 5
  if (!Number.isInteger(retries) || retries < 0 || retries > 10) throw new ProtocolError('评测重试次数必须是 0..10')
  if (spec.model && (Object.keys(spec.model).some((key) => !['model', 'reasoningEffort', 'maxTokens'].includes(key))
      || (spec.model.model !== undefined && !/^[\w.:-]+$/u.test(spec.model.model))
      || (spec.model.reasoningEffort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(spec.model.reasoningEffort))
      || (spec.model.maxTokens !== undefined && (!Number.isSafeInteger(spec.model.maxTokens) || spec.model.maxTokens < 1)))) {
    throw new ProtocolError('评测 model 覆盖配置无效')
  }
  return spec
}

/** 仅创建 Solver 与 Environment，冠军测试不再依赖安装旧的 Updater CLI。 */
export async function createEvaluationEnvironment({ repositoryRoot, bundle, runRoot }) {
  const docker = new DockerClient(bundle.environment.docker)
  validateModelGatewayEnvironment(bundle.environment.modelGateway)
  const gateway = new ModelGateway({ config: bundle.environment.modelGateway, docker, repositoryRoot,
    scopeId: `eval-${basename(runRoot)}` })
  const solver = createSolverDriver({ target: bundle.target, provider: bundle.providers.solver, docker,
    repositoryRoot, sourceRevision: bundle.target.source.revision, sourcePath: bundle.target.source.path, modelGateway: gateway })
  const environment = createEnvironmentRunner({ repositoryRoot, environment: bundle.environment, benchmark: bundle.benchmark,
    target: bundle.target, solverDriver: solver, docker, runRoot })
  try {
    await environment.preflight()
    await environment.ensureRuntime?.()
    return { environment, identity: { runtimeRevision: environment.runtimeRevision ?? null,
      runtimeIdentity: environment.runtimeIdentity ?? null }, close: () => gateway.stop() }
  } catch (error) { await gateway.stop(); throw error }
}

export async function runEvaluationJob({ repositoryRoot, configPath, resume = false, dryRun = false, onEvent = () => {} },
  { environmentFactory = createEvaluationEnvironment } = {}) {
  repositoryRoot = await realpath(repositoryRoot)
  const spec = validateRequest(await readConfigFile(configPath))
  if (spec.mode === 'sealed-final') {
    const runDirectory = await evaluationPath(repositoryRoot, spec.run, '正式评测 Run')
    if (dryRun) return { mode: spec.mode, runDirectory, notice: '仅校验路径；正式授权仍由 finalize 执行' }
    return finalizeEvolution({ repositoryRoot, runDirectory, finalOnly: true, recoverInfrastructure: resume, onEvent })
  }
  const experimentPath = await evaluationPath(repositoryRoot, spec.experiment, '评测 Experiment', 'file')
  const bundle = await loadExperimentBundle(experimentPath, repositoryRoot)
  if (spec.partition === 'final' && bundle.benchmark.finalEvaluation === 'disabled') throw new ProtocolError('该 Benchmark 禁用 Final')
  const candidates = await resolveEvaluationCandidates(repositoryRoot, spec.candidates)
  const outputRoot = resolveInside(repositoryRoot, spec.output, '评测输出目录')
  if (!/^[a-z0-9][a-z0-9._-]{2,100}$/u.test(basename(outputRoot)) || !relative(repositoryRoot, outputRoot).startsWith('.rsi/')) {
    throw new ProtocolError('评测结果必须写入 .rsi/ 下独立命名目录')
  }
  for (const candidate of candidates) {
    if (outputRoot.startsWith(`${candidate.candidateWorkspace}/`) || candidate.candidateWorkspace.startsWith(`${outputRoot}/`)
        || outputRoot === candidate.candidateWorkspace) throw new ProtocolError('评测输出目录与候选必须分离')
  }
  let outputStat
  try { outputStat = await lstat(outputRoot) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (outputStat && (outputStat.isSymbolicLink() || !outputStat.isDirectory())) throw new ProtocolError('评测输出不能是符号链接或普通文件')
  if (outputStat) evaluationInside(repositoryRoot, await realpath(outputRoot), '评测输出目录')
  const model = { ...bundle.experiment.models.solver, ...spec.model }
  const seeds = spec.seeds ?? bundle.experiment.evolution.seeds.slice(0, bundle.experiment.evolution.trialsPerInstance)
  const expectedIds = bundle.benchmark.partitions[spec.partition].instanceIds
  if (!expectedIds.length) throw new ProtocolError('评测分区没有题目')
  if (dryRun) return { kind: 'EvaluationJobPlan', mode: 'exploratory', model, seeds, tasks: expectedIds.length,
    candidates: candidates.map(({ candidateId, candidateDigest }) => ({ candidateId, candidateDigest })) }
  await mkdir(dirname(outputRoot), { recursive: true })
  evaluationInside(repositoryRoot, await realpath(dirname(outputRoot)), '评测输出父目录')
  const runtime = await environmentFactory({ repositoryRoot, bundle, runRoot: outputRoot })
  try {
    return await runEvaluationSession({ outputRoot, candidates, environment: runtime.environment, partition: spec.partition,
      model, seeds, expectedIds, resume, infrastructureRetries: spec.infrastructureRetries ?? 5, onEvent,
      identityInputs: { metric: bundle.environment.protocol === 'hle-text-math-docker-v1'
          ? 'hle-judge-correctness-v1' : 'controller-normalized-reward-v1',
        environment: bundle.environment, benchmark: bundle.benchmark.source,
        runtime: runtime.identity, runtimeInputs: await captureRuntimeInputs({
          updater: { runtime: {} }, providers: { solver: bundle.providers.solver },
        }),
        implementation: await captureExecutionIdentity(repositoryRoot) } })
  } finally { await runtime.close() }
}
