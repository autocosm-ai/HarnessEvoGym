import assert from 'node:assert/strict'
import test from 'node:test'
import { environmentCapabilities, supportsTaskInfrastructureRetries } from '../src/environment-capabilities.mjs'

import {
  createEnvironmentRunner,
  createSolverDriver,
  createUpdaterDriver,
  registerEnvironmentDriver,
  registeredDriverProtocols,
  registerSolverDriver,
  registerUpdaterDriver,
} from '../src/factories.mjs'

test('Driver Registry 暴露带版本的内置协议', () => {
  const protocols = registeredDriverProtocols()
  assert.deepEqual(protocols.environment, [
    'omegause-officeval-docker-v1',
    'text-reasoning-deterministic-v1',
  ])
  assert.deepEqual(protocols.solver, ['dsh-headless-docker-v1', 'msa-minimal-docker-v1'])
  assert.deepEqual(protocols.updater, [
    'claude-code-exec-v1',
    'codex-exec-v1',
    'dsh-headless-docker-v1',
  ])
})

test('受审查的 Contributor Driver 可以注册，编排器只依赖接口', () => {
  registerEnvironmentDriver('fixture-environment-v1', () => ({
    async preflight() {},
    async runCandidatePartition() {},
  }))
  registerSolverDriver('fixture-solver-v1', () => ({
    async ensureRuntime() {},
    async run() {},
    usage() { return {} },
  }))
  registerUpdaterDriver('fixture-updater-v1', () => ({
    async ensureRuntime() {},
    async stageContext() {},
    async run() {},
    usage() { return {} },
  }))

  const environment = createEnvironmentRunner({ environment: { protocol: 'fixture-environment-v1' } })
  assert.equal(environmentCapabilities(environment).supportsTaskRetry, false)
  assert.ok(createSolverDriver({ target: { solver: { protocol: 'fixture-solver-v1' } } }))
  assert.ok(createUpdaterDriver({ updater: { protocol: 'fixture-updater-v1' } }))
})

test('环境能力兼容旧驱动，并拒绝自相矛盾的恢复声明', () => {
  assert.equal(supportsTaskInfrastructureRetries({ supportsTaskInfrastructureRetries: true }), true)
  const capabilities = {
    apiVersion: 'harness-rsi/v1alpha1', partitions: ['feedback', 'final'],
    supportsFeedback: true, supportsHiddenFinal: true,
    supportsTaskRetry: true, supportsCheckpointResume: true,
  }
  const driver = { describeCapabilities: () => capabilities }
  assert.equal(supportsTaskInfrastructureRetries(driver), true)
  assert.throws(() => environmentCapabilities({
    ...driver, supportsTaskInfrastructureRetries: false,
  }), /不一致/u)
  capabilities.supportsCheckpointResume = false
  assert.throws(() => environmentCapabilities(driver), /不一致/u)
})

test('Driver Registry 拒绝覆盖协议和不完整实现', () => {
  assert.throws(
    () => registerSolverDriver('dsh-headless-docker-v1', () => ({})),
    /重复注册/u,
  )
  registerSolverDriver('fixture-invalid-v1', () => ({ async run() {} }))
  assert.throws(
    () => createSolverDriver({ target: { solver: { protocol: 'fixture-invalid-v1' } } }),
    /缺少 ensureRuntime/u,
  )
})

test('Updater 启动前撤销 Solver Token，结束后撤销 Updater Token', async () => {
  const calls = []
  const driver = createUpdaterDriver({
    updater: {
      protocol: 'dsh-headless-docker-v1',
      runtime: {},
    },
    provider: {
      compatibility: { maxTokensField: 'max_tokens' },
    },
    docker: {},
    repositoryRoot: '/repo',
    sourceRevision: 'a'.repeat(40),
    sourcePath: 'sources/deepseek-harness',
    modelGateway: {
      async rotateRoleToken(role) { calls.push(`rotate:${role}`) },
      async access(role) {
        calls.push(`access:${role}`)
        throw new Error('fixture-stop-before-runtime')
      },
    },
  })

  await assert.rejects(
    () => driver.run({ model: { model: 'trusted-updater', maxTokens: 64 } }),
    /fixture-stop-before-runtime/u,
  )
  assert.deepEqual(calls, [
    'rotate:solver',
    'access:updater',
    'rotate:updater',
  ])
})
