import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildBubblewrapInvocation } from '../src/sandbox.mjs'
import { runProcess } from '../src/subprocess.mjs'

const available = process.platform === 'linux' && process.getuid?.() > 0
  && existsSync('/usr/bin/bwrap') && existsSync('/usr/bin/setpriv')

async function networkNamespaceSkipReason() {
  if (!available) return '需要 Linux 普通用户、bubblewrap 和 setpriv'

  const probe = await runProcess({
    command: '/usr/bin/setpriv',
    args: [
      `--reuid=${process.getuid()}`,
      `--regid=${process.getgid()}`,
      '--keep-groups',
      '--no-new-privs',
      '/usr/bin/bwrap',
      '--die-with-parent',
      '--new-session',
      '--unshare-user',
      '--unshare-pid',
      '--unshare-ipc',
      '--unshare-uts',
      '--unshare-cgroup',
      '--unshare-net',
      '--uid', '0',
      '--gid', '0',
      '--cap-drop', 'ALL',
      '--ro-bind', '/usr', '/usr',
      '--symlink', 'usr/bin', '/bin',
      '--symlink', 'usr/sbin', '/sbin',
      '--symlink', 'usr/lib', '/lib',
      '--symlink', 'usr/lib64', '/lib64',
      '--dir', '/proc',
      '--dev', '/dev',
      '--dir', '/tmp',
      '--tmpfs', '/tmp',
      '--',
      '/usr/bin/true',
    ],
    cwd: '/',
    env: { PATH: '/usr/bin:/bin' },
    timeoutMs: 10000,
  })
  if (probe.ok) return null
  if (/operation not permitted|permission denied|not supported/iu.test(probe.stderr)) {
    return `当前 runner 禁止 Bubblewrap 创建可配置的网络命名空间：${probe.stderr.trim()}`
  }
  throw new Error(`Bubblewrap 能力探测异常：${probe.stderr || probe.stdout}`)
}

const skipReason = await networkNamespaceSkipReason()

for (const preserveUserIdentity of [false, true]) {
  test(`真实沙箱 UID 映射与可写挂载：保留身份=${preserveUserIdentity}`, {
    skip: skipReason ?? false,
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'sandbox-user-identity-'))
    const hostHomePath = process.env.HOME ?? tmpdir()
    const hiddenHostPath = join(hostHomePath, '.codex')
    try {
      const invocation = buildBubblewrapInvocation({
        invocation: {
          command: '/usr/bin/sh',
          args: [
            '-c',
            'id -u; id -g; printf verified > /work/marker; test ! -e '
              + JSON.stringify(hiddenHostPath),
          ],
          cwd: root, env: { PATH: '/usr/bin:/bin' },
        },
        mounts: [{ source: root, destination: '/work', readOnly: false }],
        uid: process.getuid(), gid: process.getgid(),
        preserveSupplementaryGroups: true, preserveUserIdentity,
      })
      const result = await runProcess({ ...invocation, timeoutMs: 10000 })
      assert.equal(result.ok, true, result.stderr)
      assert.equal(result.stdout, preserveUserIdentity
        ? `${process.getuid()}\n${process.getgid()}\n` : '0\n0\n')
      assert.equal(await readFile(join(root, 'marker'), 'utf8'), 'verified')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}
