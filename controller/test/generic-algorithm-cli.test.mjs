import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import test from 'node:test'

import { REPOSITORY_ROOT } from '../src/config.mjs'

function runCli(args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['controller/src/cli.mjs', ...args], {
      cwd: REPOSITORY_ROOT,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code, signal) => resolvePromise({ code, signal, stdout, stderr }))
  })
}

test('CLI 可以加载 Algorithm v2 插件并创建可恢复的 Run', async () => {
  await mkdir(join(REPOSITORY_ROOT, '.rsi'), { recursive: true })
  const tempRoot = await mkdtemp(join(REPOSITORY_ROOT, '.rsi', 'algorithm-cli-'))
  const runRoot = relative(REPOSITORY_ROOT, join(tempRoot, 'run'))
  const plugin = 'sdk/examples/algorithm-v2-smoke'
  try {
    const first = await runCli([
      'algorithm', 'run', '--plugin', plugin, '--algorithm', 'algorithm-v2-smoke-v2',
      '--run-root', runRoot, '--steps', '1',
    ])
    assert.equal(first.code, 0, first.stderr)
    const firstReport = JSON.parse(first.stdout)
    assert.equal(firstReport.kind, 'AlgorithmRunReport')
    assert.equal(firstReport.complete, false)
    assert.equal(firstReport.steps, 1)

    const resumed = await runCli([
      'algorithm', 'run', '--plugin', plugin, '--algorithm', 'algorithm-v2-smoke-v2',
      '--run-root', runRoot, '--steps', '2', '--resume', '--resume-checkpoint', 'step-000001.json',
    ])
    assert.equal(resumed.code, 0, resumed.stderr)
    const resumedReport = JSON.parse(resumed.stdout)
    assert.equal(resumedReport.complete, true)
    assert.equal(resumedReport.status, 'completed')
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test('仓库外插件组合完成代码搜索、跨进程恢复与冠军评测，配置和源码漂移均被拒绝', async () => {
  const external = await mkdtemp(join(tmpdir(), 'external-plugins-'))
  const local = await mkdtemp(join(REPOSITORY_ROOT, '.rsi', 'external-run-'))
  try {
    await cp(join(REPOSITORY_ROOT, 'sdk/examples/affine-search'), external, { recursive: true })
    const contextPath = join(local, 'context.json')
    await writeFile(contextPath, '{}')
    const common = ['algorithm', 'run', '--plugins', join(external, 'plugins.json'),
      '--algorithm', 'affine-beam-search-v2', '--run-root', relative(REPOSITORY_ROOT, join(local, 'run')),
      '--context', relative(REPOSITORY_ROOT, contextPath)]
    const first = await runCli([...common, '--steps', '1'])
    assert.equal(first.code, 0, first.stderr)
    assert.equal(JSON.parse(first.stdout).complete, false)
    const checkpointPath = join(local, 'run/checkpoints/step-000001.json')
    const checkpoint = await readFile(checkpointPath, 'utf8')
    await writeFile(contextPath, '{"differentTasks":true}')
    const changed = await runCli([...common, '--steps', '4', '--resume'])
    assert.notEqual(changed.code, 0)
    assert.match(changed.stderr, /任务配置已改变/u)
    await writeFile(contextPath, '{}')
    const resumed = await runCli([...common, '--steps', '6', '--resume', '--resume-checkpoint', 'step-000001.json'])
    assert.equal(resumed.code, 0, resumed.stderr)
    const report = JSON.parse(resumed.stdout)
    assert.equal(report.complete, true)
    assert.equal(report.report.finalScore, 1)
    assert.ok(report.report.champion.score > report.report.baselineScore)
    assert.equal(await readFile(checkpointPath, 'utf8'), checkpoint)
    const tasksBefore = await readdir(join(local, 'run/trials'))
    const repeat = await runCli([...common, '--steps', '1', '--resume'])
    assert.equal(repeat.code, 0, repeat.stderr)
    assert.deepEqual(await readdir(join(local, 'run/trials')), tasksBefore)
    await writeFile(join(external, 'algorithm/index.mjs'), 'throw new Error("drift-code-executed");')
    const drift = await runCli([...common, '--resume'])
    assert.notEqual(drift.code, 0)
    assert.match(drift.stderr, /插件源码或任务配置已改变/u)
    assert.doesNotMatch(drift.stderr, /drift-code-executed/u)
  } finally {
    await rm(external, { recursive: true, force: true })
    await rm(local, { recursive: true, force: true })
  }
})
