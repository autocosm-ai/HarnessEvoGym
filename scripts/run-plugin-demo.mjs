#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { REPOSITORY_ROOT } from '../controller/src/config.mjs'

await mkdir(join(REPOSITORY_ROOT, '.rsi'), { recursive: true })
const runRoot = `.rsi/plugin-demo-${Date.now()}`
const common = ['controller/src/cli.mjs', 'algorithm', 'run', '--plugins', 'sdk/examples/affine-search/plugins.json',
  '--algorithm', 'affine-beam-search-v2', '--run-root', runRoot]
for (const options of [['--steps', '1'], ['--steps', '6', '--resume'], ['--steps', '1', '--resume']]) {
  const child = spawnSync(process.execPath, [...common, ...options], { cwd: REPOSITORY_ROOT, encoding: 'utf8' })
  if (child.stderr) process.stderr.write(child.stderr)
  if (child.status !== 0) throw new Error(`插件示例子进程失败：${child.error?.message ?? child.status}`)
  const report = JSON.parse(child.stdout)
  if (options.includes('--resume') && (!report.complete || report.report.finalScore !== 1)) {
    throw new Error('插件恢复或最终评测没有通过')
  }
  console.log(JSON.stringify(report))
}
console.log(`插件示例完成：${relative(REPOSITORY_ROOT, join(REPOSITORY_ROOT, runRoot))}`)
