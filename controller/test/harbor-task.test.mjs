import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadHarborTask, validateHarborTaskToml } from '../src/environments/harbor-task.mjs'

function document() {
  return {
    schema_version: '1.0', artifacts: ['/app/result.txt'], metadata: {},
    verifier: { environment_mode: 'separate' }, agent: {}, environment: {},
  }
}

test('Harbor 校验支持范围、路径和资源', () => {
  assert.equal(validateHarborTaskToml(document(), '/tasks/example').agent.timeoutSeconds, 120)
  for (const artifact of ['/app', '/app/../secret', '/app//result', '/app/./result', '/outside/result']) {
    assert.throws(() => validateHarborTaskToml({ ...document(), artifacts: [artifact] }), /Harbor/)
  }
  for (const mode of ['shared', undefined]) {
    assert.throws(() => validateHarborTaskToml({ ...document(), verifier: { environment_mode: mode } }), /separate/)
  }
  for (const environment of [{ cpus: '1' }, { memory_mb: -1 }, { gpus: 1 }, { allow_internet: 'true' }]) {
    assert.throws(() => validateHarborTaskToml({ ...document(), environment }), /Harbor/)
  }
})

test('Harbor 摘要覆盖 verifier 辅助文件并拒绝符号链接', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harbor-task-'))
  const task = join(root, 'example')
  try {
    await mkdir(join(task, 'environment'), { recursive: true })
    await mkdir(join(task, 'tests'))
    const files = {
      'task.toml': 'schema_version = "1.0"\nartifacts = ["/app/result.txt"]\n[metadata]\n[verifier]\nenvironment_mode = "separate"\n[agent]\n[environment]\n',
      'instruction.md': '生成 result.txt。',
      'environment/Dockerfile': 'FROM scratch\n',
      'tests/Dockerfile': 'FROM scratch\n',
      'tests/test.sh': 'echo 1\n',
      'tests/helper.py': 'value = 1\n',
    }
    for (const [path, content] of Object.entries(files)) await writeFile(join(task, path), content)
    const first = await loadHarborTask(root, 'example')
    await writeFile(join(task, 'tests/helper.py'), 'value = 2\n')
    assert.notEqual((await loadHarborTask(root, 'example')).digest, first.digest)
    await symlink('/etc/passwd', join(task, 'tests/link'))
    await assert.rejects(loadHarborTask(root, 'example'), /符号链接/)
    await symlink(task, join(root, 'alias'))
    await assert.rejects(loadHarborTask(root, 'alias'), /符号链接/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
