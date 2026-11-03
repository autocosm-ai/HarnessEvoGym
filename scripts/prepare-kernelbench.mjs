#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readConfigFile, REPOSITORY_ROOT, resolveInside } from '../controller/src/config.mjs'
import { loadHarborTask } from '../controller/src/environments/harbor-task.mjs'

export const DEFAULT_KERNELBENCH_TASKS = [
  'level1/1_Square_matrix_multiplication_.py',
  'level1/2_Standard_matrix_multiplication_.py',
  'level2/40_Matmul_Scaling_ResidualAdd.py',
]

/** 拷贝上游原始任务，不改输入形状；产物独立存放，保留来源和许可证。 */
export async function prepareKernelBench({ sourceRoot, outputRoot, repositoryRoot = REPOSITORY_ROOT,
  tasks = DEFAULT_KERNELBENCH_TASKS }) {
  if (!Array.isArray(tasks) || tasks.length !== 3 || new Set(tasks).size !== 3
      || tasks.some((task) => !/^level[123]\/[A-Za-z0-9_]+\.py$/u.test(task))) {
    throw new Error('需提供三个不同的 KernelBench 相对任务路径，分别用作 feedback、selection、final')
  }
  const source = resolve(sourceRoot)
  const output = resolveInside(join(repositoryRoot, '.rsi'), relative(join(repositoryRoot, '.rsi'), resolve(outputRoot)), 'KernelBench 输出目录')
  if (output === join(repositoryRoot, '.rsi')) throw new Error('输出不能是 .rsi 根目录')
  const revision = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  if (!/^[0-9a-f]{40,64}$/u.test(revision)) throw new Error('上游必须指向固定 Git 提交')
  const blob = (path) => execFileSync('git', ['-C', source, 'show', `${revision}:${path}`], { maxBuffer: 4 * 1024 * 1024 })
  const inputs = tasks.map((task) => blob(`KernelBench/${task}`))
  const license = blob('LICENSE')
  const evaluator = await readFile(join(repositoryRoot, 'docker/kernelbench-runtime/evaluate.py'))
  await mkdir(dirname(output), { recursive: true })
  await mkdir(output, { recursive: false })
  const taskIds = []
  const provenance = []
  for (const [index, path] of tasks.entries()) {
    const id = path.replace('/', '-').replace('.py', '').replaceAll('_', '-').toLowerCase().replace(/-+$/u, '')
    taskIds.push(id)
    const root = join(output, 'tasks', id)
    await mkdir(join(root, 'environment'), { recursive: true })
    await mkdir(join(root, 'tests'))
    const dockerBase = 'FROM harness-rsi/kernelbench-dev:v1\n'
    await writeFile(join(root, 'environment/Dockerfile'), dockerBase + 'COPY reference.py model_new.py /workspace/\n')
    await writeFile(join(root, 'tests/Dockerfile'), dockerBase + 'COPY reference.py evaluate.py test.sh /tests/\n')
    for (const folder of ['environment', 'tests']) await writeFile(join(root, folder, 'reference.py'), inputs[index])
    await writeFile(join(root, 'environment/model_new.py'), 'from reference import Model\n\nclass ModelNew(Model):\n    pass\n')
    await writeFile(join(root, 'tests/evaluate.py'), evaluator)
    await writeFile(join(root, 'tests/test.sh'), '#!/usr/bin/env bash\nset -euo pipefail\npython /tests/evaluate.py /workspace/model_new.py\n')
    await writeFile(join(root, 'task.toml'), `schema_version = "1.0"\nartifacts = ["/workspace/model_new.py"]\n[metadata]\nname = "${id}"\ncategory = "kernelbench"\ntags = ["cuda", "requires-cuda-compiler"]\n[verifier]\nenvironment_mode = "separate"\ntimeout_seconds = 900\n[agent]\ntimeout_seconds = 1800\n[environment]\ncpus = 4\nmemory_mb = 16384\nstorage_mb = 2048\ngpus = 1\nbuild_timeout_seconds = 1200\nallow_internet = false\n`)
    await writeFile(join(root, 'instruction.md'), `# KernelBench ${path}\n\n优化 model_new.py 中的 ModelNew，保持 reference.py 的原始输入形状、初始化和数值语义。只交付 model_new.py，所有自定义内核源码须内嵌于该文件。允许 PyTorch、CUDA C++ JIT（NVCC 11.8）；先检查 GPU compute capability，只有支持时才使用 Triton。不得联网安装依赖，不得修改输入和参考实现。编译与预热不计入测速。评分为 speedup / (1 + speedup)，错误记零。请先做数值验证再优化。\n`)
    provenance.push({ task: id, upstreamPath: path, sha256: createHash('sha256').update(inputs[index]).digest('hex') })
  }
  const loaded = await Promise.all(taskIds.map((id) => loadHarborTask(join(output, 'tasks'), id, { workspacePath: '/workspace', allowGpu: true })))
  const digest = createHash('sha256').update(loaded.sort((a, b) => a.name.localeCompare(b.name)).map((task) => `${task.name}:${task.digest}`).join('\n')).digest('hex')
  const writeJson = (name, value) => writeFile(join(output, name), JSON.stringify(value, null, 2) + '\n')
  const env = await readConfigFile(join(repositoryRoot, 'environments/kernelbench-gpu.yml'))
  env.metadata.id = 'kernelbench-cuda-original'
  env.spec.source = { tasksRoot: relative(repositoryRoot, join(output, 'tasks')), digest }
  env.spec.runtime.imagePrefix = 'harness-rsi/kernelbench-cuda'
  await writeJson('environment.json', env)
  await writeJson('benchmark.json', { apiVersion: 'harness-rsi/v1alpha1', kind: 'Benchmark', metadata: { id: 'kernelbench-cuda-original', name: 'KernelBench selected tasks with original input shapes' }, spec: {
    source: { adapter: env.metadata.id, dataset: `ScalingIntelligence/KernelBench@${revision}`, split: 'selected-original-shapes', revision: digest },
    evaluator: { adapter: env.metadata.id, resultFormat: 'harness-rsi/solver-result-jsonl-v2' },
    partitions: Object.fromEntries(['feedback', 'selection', 'final'].map((name, i) => [name, { visibility: ['detailed', 'aggregate-only', 'sealed'][i], expectedCount: 1, instanceIds: [taskIds[i]] }])), expectedTotal: 3 } })
  const experiment = await readConfigFile(join(repositoryRoot, 'experiments/kernelbench-smoke-msa-single.json'))
  experiment.metadata.id = 'kernelbench-cuda-acceptance'
  experiment.spec.recipe = 'recipes/acceptance-single-b2.yml'
  experiment.spec.adapters.environment = relative(repositoryRoot, join(output, 'environment.json'))
  experiment.spec.benchmark = relative(repositoryRoot, join(output, 'benchmark.json'))
  experiment.spec.evolution.generations = 2
  await writeJson('experiment.json', experiment)
  await writeJson('provenance.json', { source: 'https://github.com/ScalingIntelligence/KernelBench', revision, inputShapes: 'unchanged', tasks: provenance, taskTreeDigest: digest })
  await writeFile(join(output, 'UPSTREAM-LICENSE'), license)
  return { root: output, revision, tasks: taskIds, digest, experiment: relative(repositoryRoot, join(output, 'experiment.json')) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length !== 4 || args[0] !== '--source' || args[2] !== '--output') throw new Error('用法：prepare-kernelbench.mjs --source <upstream-repo> --output <新的 .rsi 子目录>')
  console.log(JSON.stringify(await prepareKernelBench({ sourceRoot: args[1], outputRoot: args[3] }), null, 2))
}
