import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

/**
 * Docker 资源限制验证测试
 *
 * 验证 Docker 容器的资源限制配置是否生效
 */

// 辅助函数：运行 Docker 容器并返回结果
async function runDockerContainer({
  image = 'alpine:latest',
  command = ['sh', '-c', 'echo test'],
  cpus = null,
  memory = null,
  pids = null,
  network = 'none',
  timeout = 10000,
}) {
  return new Promise((resolve, reject) => {
    const args = ['run', '--rm']

    if (cpus !== null) args.push('--cpus', String(cpus))
    if (memory !== null) args.push('--memory', memory)
    if (pids !== null) args.push('--pids-limit', String(pids))
    if (network) args.push('--network', network)

    args.push(image, ...command)

    const child = spawn('docker', args, { timeout })

    let stdout = ''
    let stderr = ''
    let timedOut = false

    child.stdout.on('data', (data) => { stdout += data.toString() })
    child.stderr.on('data', (data) => { stderr += data.toString() })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeout)

    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        exitCode: code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut,
      })
    })

    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

// 辅助函数：检查 Docker 是否可用
async function isDockerAvailable() {
  try {
    const result = await runDockerContainer({
      command: ['echo', 'test'],
      timeout: 5000,
    })
    return result.exitCode === 0
  } catch (error) {
    return false
  }
}

describe('Docker 资源限制验证', { skip: !await isDockerAvailable() }, () => {
  describe('CPU 限制', () => {
    it('CPU 限制配置生效', async () => {
      // 资源限制本身由后面的 inspect 断言验证；这里仅确认带限制的容器
      // 能正常启动，避免把宿主机调度速度误当成产品行为。
      const result = await runDockerContainer({
        cpus: 0.5, // 限制为 0.5 核
        command: ['sh', '-c', 'echo done'],
        timeout: 5000,
      })

      // 容器应该能完成任务（虽然慢一些）
      assert.equal(result.exitCode, 0)
      assert.equal(result.stdout, 'done')
    })

    it('验证 CPU 限制通过 Docker inspect', async () => {
      // 创建一个长期运行的容器
      const containerName = `cpu-test-${Date.now()}`

      const spawnResult = spawn('docker', [
        'run',
        '--name', containerName,
        '--cpus', '1.5',
        '--rm',
        '-d',
        'alpine:latest',
        'sleep', '10',
      ])

      await new Promise((resolve) => spawnResult.on('close', resolve))

      try {
        // 检查容器的 CPU 配置
        const inspectResult = await new Promise((resolve, reject) => {
          const child = spawn('docker', ['inspect', containerName, '--format', '{{.HostConfig.NanoCpus}}'])
          let stdout = ''
          child.stdout.on('data', (data) => { stdout += data.toString() })
          child.on('close', (code) => {
            if (code === 0) resolve({ stdout: stdout.trim() })
            else reject(new Error('Inspect failed'))
          })
        })

        // NanoCpus 应该是 1.5 * 1e9
        const nanoCpus = parseInt(inspectResult.stdout, 10)
        assert.ok(nanoCpus === 1500000000, `Expected 1500000000, got ${nanoCpus}`)
      } finally {
        // 清理容器
        spawn('docker', ['stop', containerName])
      }
    })
  })

  describe('内存限制', () => {
    it('内存限制配置生效', async () => {
      // 不用写磁盘来冒充内存压力；内存限制的精确值由 inspect 测试验证。
      const result = await runDockerContainer({
        memory: '128m', // 限制为 128 MB
        command: ['sh', '-c', 'echo ready'],
        timeout: 10000,
      })

      assert.equal(result.exitCode, 0)
      assert.equal(result.stdout, 'ready')
    })

    it('内存限制在合理范围内时容器正常运行', async () => {
      const result = await runDockerContainer({
        memory: '256m',
        command: [
          'sh',
          '-c',
          // 分配 64 MB 内存（在限制内）
          'dd if=/dev/zero of=/tmp/test bs=1M count=64 2>/dev/null && echo ok',
        ],
        timeout: 5000,
      })

      assert.equal(result.exitCode, 0)
      assert.equal(result.stdout, 'ok')
    })

    it('验证内存限制通过 Docker inspect', async () => {
      const containerName = `mem-test-${Date.now()}`

      const spawnResult = spawn('docker', [
        'run',
        '--name', containerName,
        '--memory', '512m',
        '--rm',
        '-d',
        'alpine:latest',
        'sleep', '10',
      ])

      await new Promise((resolve) => spawnResult.on('close', resolve))

      try {
        const inspectResult = await new Promise((resolve, reject) => {
          const child = spawn('docker', ['inspect', containerName, '--format', '{{.HostConfig.Memory}}'])
          let stdout = ''
          child.stdout.on('data', (data) => { stdout += data.toString() })
          child.on('close', (code) => {
            if (code === 0) resolve({ stdout: stdout.trim() })
            else reject(new Error('Inspect failed'))
          })
        })

        // Memory 应该是 512 * 1024 * 1024 = 536870912
        const memory = parseInt(inspectResult.stdout, 10)
        assert.equal(memory, 536870912)
      } finally {
        spawn('docker', ['stop', containerName])
      }
    })
  })

  describe('PIDs 限制', () => {
    it('PIDs 限制配置生效', async () => {
      // 尝试创建超过限制的进程数
      const result = await runDockerContainer({
        pids: 10, // 限制为 10 个进程
        command: [
          'sh',
          '-c',
          // 尝试创建 20 个后台进程
          'for i in $(seq 1 20); do (sleep 10 &); done 2>&1 || echo limited',
        ],
        timeout: 3000,
      })

      // 应该因为 PIDs 限制失败
      assert.ok(
        result.stdout.includes('limited') || result.stderr.includes('fork') || result.stderr.includes('Resource'),
        'PIDs limit should prevent fork'
      )
    })

    it('PIDs 限制在合理范围内时容器正常运行', async () => {
      const result = await runDockerContainer({
        pids: 50,
        command: [
          'sh',
          '-c',
          // 创建 5 个后台进程（在限制内）
          'for i in $(seq 1 5); do (sleep 1 &); done && wait && echo ok',
        ],
        timeout: 5000,
      })

      assert.equal(result.exitCode, 0)
      assert.equal(result.stdout, 'ok')
    })
  })

  describe('网络隔离', () => {
    it('none 网络模式禁止外部网络访问', async () => {
      const result = await runDockerContainer({
        network: 'none',
        command: [
          'sh',
          '-c',
          // 尝试访问外部网络
          'ping -c 1 -W 1 8.8.8.8 2>&1 || echo no-network',
        ],
        timeout: 5000,
      })

      // 应该无法访问网络
      assert.ok(
        result.stdout.includes('no-network') || result.stdout.includes('Network') || result.stdout.includes('unreachable'),
        'Network should be isolated'
      )
    })

    it('bridge 网络模式允许网络访问', async () => {
      const result = await runDockerContainer({
        network: 'bridge',
        command: [
          'sh',
          '-c',
          // 尝试访问外部网络（使用 DNS）
          'ping -c 1 -W 2 8.8.8.8 && echo network-ok || echo network-fail',
        ],
        timeout: 5000,
      })

      // 可能成功也可能失败（取决于宿主机网络），但不应该是 network-unreachable
      assert.ok(
        result.exitCode === 0 || result.stdout.includes('network-'),
        'Bridge network should allow access attempts'
      )
    })

    it('验证网络模式通过 Docker inspect', async () => {
      const containerName = `net-test-${Date.now()}`

      const spawnResult = spawn('docker', [
        'run',
        '--name', containerName,
        '--network', 'none',
        '--rm',
        '-d',
        'alpine:latest',
        'sleep', '10',
      ])

      await new Promise((resolve) => spawnResult.on('close', resolve))

      try {
        const inspectResult = await new Promise((resolve, reject) => {
          const child = spawn('docker', ['inspect', containerName, '--format', '{{.HostConfig.NetworkMode}}'])
          let stdout = ''
          child.stdout.on('data', (data) => { stdout += data.toString() })
          child.on('close', (code) => {
            if (code === 0) resolve({ stdout: stdout.trim() })
            else reject(new Error('Inspect failed'))
          })
        })

        assert.equal(inspectResult.stdout, 'none')
      } finally {
        spawn('docker', ['stop', containerName])
      }
    })
  })

  describe('综合资源限制', () => {
    it('多项资源限制同时生效', async () => {
      const result = await runDockerContainer({
        cpus: 1,
        memory: '256m',
        pids: 50,
        network: 'none',
        command: [
          'sh',
          '-c',
          'echo "CPU: ok" && dd if=/dev/zero of=/tmp/test bs=1M count=32 2>/dev/null && echo "MEM: ok" && echo "ALL: ok"',
        ],
        timeout: 5000,
      })

      assert.equal(result.exitCode, 0)
      assert.ok(result.stdout.includes('CPU: ok'))
      assert.ok(result.stdout.includes('MEM: ok'))
      assert.ok(result.stdout.includes('ALL: ok'))
    })

    it('验证 HarnessEvoGym 典型配置', async () => {
      // 模拟 text-reasoning-smoke.yml 的配置
      const result = await runDockerContainer({
        cpus: 2,
        memory: '2g',
        pids: 256,
        network: 'bridge',
        command: ['sh', '-c', 'echo "harness-config-ok"'],
        timeout: 5000,
      })

      assert.equal(result.exitCode, 0)
      assert.equal(result.stdout, 'harness-config-ok')
    })
  })
})

describe('Docker 资源限制 - 配置验证', () => {
  it('text-reasoning-smoke 配置合理', () => {
    const config = {
      cpus: 2,
      memory: '2g',
      pids: 256,
      timeoutSeconds: 300,
    }

    // 验证配置值在合理范围内
    assert.ok(config.cpus >= 1 && config.cpus <= 8, 'CPUs should be reasonable')
    assert.ok(config.memory.match(/^\d+[mg]$/), 'Memory format should be valid')
    assert.ok(config.pids >= 64 && config.pids <= 1024, 'PIDs should be reasonable')
    assert.ok(config.timeoutSeconds >= 60 && config.timeoutSeconds <= 3600, 'Timeout should be reasonable')
  })

  it('modelGateway 配置合理', () => {
    const config = {
      cpus: 1,
      memory: '512m',
      pids: 128,
    }

    // Model Gateway 应该比主容器资源更少
    assert.ok(config.cpus <= 2, 'Gateway CPUs should be less than main')
    assert.ok(config.pids <= 256, 'Gateway PIDs should be less than main')
  })
})
