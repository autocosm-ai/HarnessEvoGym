import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
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
