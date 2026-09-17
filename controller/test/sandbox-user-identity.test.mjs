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

for (const preserveUserIdentity of [false, true]) {
  test(`真实沙箱 UID 映射与可写挂载：保留身份=${preserveUserIdentity}`, { skip: !available }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'sandbox-user-identity-'))
    try {
      const invocation = buildBubblewrapInvocation({
        invocation: {
          command: '/usr/bin/sh',
          args: ['-c', 'id -u; id -g; printf verified > /work/marker; test ! -e /home/ubuntu/.codex'],
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
