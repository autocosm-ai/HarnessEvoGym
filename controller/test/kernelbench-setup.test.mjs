import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { prepareKernelBench, DEFAULT_KERNELBENCH_TASKS } from '../../scripts/prepare-kernelbench.mjs'
import { REPOSITORY_ROOT } from '../src/config.mjs'
import { loadExperimentBundle } from '../src/adapters.mjs'
import { KernelBenchEnvironment } from '../src/environments/kernelbench.mjs'
import { HarborEnvironment } from '../src/environments/harbor.mjs'

test('KernelBench 导入固定 Git 内容、原始输入和许可证，生成可用实验且拒绝覆盖', async () => {
  const source = await mkdtemp(join(tmpdir(), 'kernelbench-source-'))
  await mkdir(join(REPOSITORY_ROOT, '.rsi'), { recursive: true })
  const output = await mkdtemp(join(REPOSITORY_ROOT, '.rsi/kernelbench-setup-'))
  try {
    await mkdir(join(source, 'KernelBench/level1'), { recursive: true })
    await mkdir(join(source, 'KernelBench/level2'), { recursive: true })
    const original = 'N = 4096\n# 原始测试输入规模，不能静默缩小\n'
    for (const name of DEFAULT_KERNELBENCH_TASKS) await writeFile(join(source, 'KernelBench', name), original)
    await writeFile(join(source, 'LICENSE'), 'MIT fixture\n')
    const git = (...args) => execFileSync('git', ['-C', source, ...args], { stdio: 'pipe' })
    git('init', '-q')
    git('add', '.')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture')
    await writeFile(join(source, 'KernelBench', DEFAULT_KERNELBENCH_TASKS[0]), 'N = 1\n')
    const prepared = await prepareKernelBench({ sourceRoot: source, outputRoot: join(output, 'tasks') })
    const bundle = await loadExperimentBundle(join(prepared.root, 'experiment.json'), REPOSITORY_ROOT)
    assert.equal(bundle.benchmark.allInstanceIds.size, 3)
    assert.equal(bundle.recipe.spec.population.budget.total_budget, 2)
    const first = join(prepared.root, 'tasks', prepared.tasks[0])
    assert.equal(await readFile(join(first, 'environment/reference.py'), 'utf8'), original)
    assert.equal(await readFile(join(first, 'tests/reference.py'), 'utf8'), original)
    assert.equal(await readFile(join(prepared.root, 'UPSTREAM-LICENSE'), 'utf8'), 'MIT fixture\n')
    await assert.rejects(() => prepareKernelBench({ sourceRoot: source, outputRoot: prepared.root }), { code: 'EEXIST' })
    await assert.rejects(() => prepareKernelBench({ sourceRoot: source, outputRoot: output, tasks: ['../bad.py', ...DEFAULT_KERNELBENCH_TASKS.slice(1)] }), /相对任务路径/u)
  } finally {
    await rm(source, { recursive: true, force: true })
    await rm(output, { recursive: true, force: true })
  }
})

test('KernelBench 正确性与速度分数分开，等速正确实现不能永远 unresolved', () => {
  const environment = new KernelBenchEnvironment({ environment: { id: 'test' } })
  assert.equal(environment.trialsResolved([{ reward: 0.5 }]), true)
  assert.equal(environment.trialsResolved([{ reward: 0.1 }, { reward: 0 }]), false)
  assert.equal(environment.trialsResolved([{ reward: 0.5, solverFailure: {} }]), false)
  assert.equal(environment.trialsResolved([]), false)
})

test('GPU 能力探测区分普通 CUDA、NVCC 和 Triton 要求，并在执行前拒绝不支持的设备', async (t) => {
  t.mock.method(HarborEnvironment.prototype, 'ensureRuntime', async () => ({ solverImage: 'fixture' }))
  const calls = []
  const environment = new KernelBenchEnvironment({ environment: { id: 'fixture', verifier: { resources: {} } },
    docker: { async run(options) { calls.push(options); return {} } } })
  const task = (tags) => ({ name: 'fixture', config: { environment: { gpus: 1 }, metadata: { tags } } })
  await environment.ensureRuntime(task([]))
  await environment.ensureRuntime(task(['requires-cuda-compiler']))
  await environment.ensureRuntime(task(['requires-cuda-compiler']))
  assert.equal(calls.length, 2, '普通 CUDA 的检查结果不能替代编译器检查')
  assert.match(calls[1].command.join(' '), /shutil.which\("nvcc"\)/u)
  environment.docker.run = async () => { const error = new Error('probe failed'); error.processResult = { stderr: 'AssertionError: Triton requires compute capability >= 7.0' }; throw error }
  await assert.rejects(() => environment.ensureRuntime(task(['requires-triton'])), /要求 Triton/u)
})
