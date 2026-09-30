#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const slash = String.fromCharCode(47)

function escapeRegex(value) {
  return value.replace(/[.*+?^()|[\]\\]/g, '\\$&')
}

function pathLiteral(...parts) {
  return parts.join(slash)
}

const forbidden = [
  {
    label: '机器数据盘路径',
    pattern: new RegExp(escapeRegex(pathLiteral('', 'data', '')), 'u'),
  },
  {
    label: '机器专属工作区路径',
    pattern: new RegExp(escapeRegex(pathLiteral('', 'workspace', 'liuzhou', '')), 'u'),
  },
  {
    label: '机器挂载盘路径',
    pattern: new RegExp(escapeRegex(pathLiteral('', 'mnt', 'bn', '')), 'u'),
  },
  {
    label: '固定用户目录路径',
    pattern: new RegExp(
      escapeRegex(pathLiteral('', 'home', ''))
        + "[^/\\s\"']+(?:" + escapeRegex(slash) + "|$)",
      'u',
    ),
  },
  {
    label: '固定 root 目录路径',
    pattern: new RegExp(escapeRegex(pathLiteral('', 'root', '')), 'u'),
  },
  {
    label: 'macOS 用户目录路径',
    pattern: new RegExp(
      escapeRegex(pathLiteral('', 'Users', '')) + "[^/\\s\"']+",
      'u',
    ),
  },
  {
    label: 'macOS 卷路径',
    pattern: new RegExp(escapeRegex(pathLiteral('', 'Volumes', '')), 'u'),
  },
  {
    label: 'Windows 盘符路径',
    pattern: /(?:^|[\s"'(=:])[A-Z]:[\\/]/u,
  },
]

const trackedFiles = execFileSync('git', ['ls-files', '-z'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
}).split('\0').filter(Boolean)

const findings = []
for (const file of trackedFiles) {
  const absoluteFile = resolve(repositoryRoot, file)
  // staged 删除的历史文件不再属于当前工作树，避免清理过程中误报。
  if (!existsSync(absoluteFile) || !lstatSync(absoluteFile).isFile()) continue
  const bytes = readFileSync(absoluteFile)
  if (bytes.includes(0)) continue
  const content = bytes.toString('utf8')
  const lines = content.split(/\r?\n/u)
  lines.forEach((line, index) => {
    for (const rule of forbidden) {
      if (rule.pattern.test(line)) {
        findings.push(relative(repositoryRoot, absoluteFile) + ':' + (index + 1) + ' ' + rule.label)
      }
    }
  })
}

if (findings.length > 0) {
  console.error('发现不可提交的机器专属绝对路径：')
  for (const finding of findings) console.error('- ' + finding)
  process.exitCode = 1
} else {
  console.log('Portable path check passed: no machine-specific absolute paths found.')
}
