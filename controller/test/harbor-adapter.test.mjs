import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateEnvironmentAdapter } from '../src/adapters.mjs'

function config() {
  return {
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'EnvironmentAdapter',
    metadata: { id: 'harbor-test' },
    spec: {
      protocol: 'harbor-task-v1',
      source: { tasksRoot: 'tasks', digest: 'a'.repeat(64) },
      task: { workspacePath: '/app', maximumConcurrentTrials: 2 },
      runtime: { imagePrefix: 'harbor-test' },
      docker: {
        binary: 'docker', network: 'bridge', runAsCurrentUser: true,
        resources: { cpus: 2, memory: '4g', pids: 128, timeoutSeconds: 900 },
      },
      modelGateway: {
        image: 'harness-rsi/model-gateway:v1', dockerfile: 'docker/model-gateway/Dockerfile',
        alias: 'model-gateway', port: 8080, egressNetwork: 'bridge',
        maximumRequestsPerRun: 100, maximumConcurrentRequests: 4, maximumUpstreamRetries: 2,
        resources: { cpus: 1, memory: '512m', pids: 64 },
      },
      verifier: { resources: { cpus: 1, memory: '1g', pids: 64 } },
      reward: { minimum: 0, maximum: 1, resolvedThreshold: 1 },
      feedback: {
        maximumTextBytesPerCase: 4096, maximumArtifactEntriesPerCase: 8,
        maximumArtifactBytesPerCase: 65536, maximumHistoryEntries: 10, maximumHistoryBytes: 65536,
      },
    },
  }
}

test('Harbor Environment Adapter 固定资源、网络和失败策略', () => {
  const normalized = validateEnvironmentAdapter(config())
  assert.equal(normalized.protocol, 'harbor-task-v1')
  assert.equal(normalized.docker.resources.memoryMb, 4096)
  assert.equal(normalized.modelGateway.resources.memoryMb, 512)
  assert.equal(normalized.solverFailurePolicy, 'verified-candidate-terminal-v1')

  const unknown = config()
  unknown.spec.task.untrusted = true
  assert.throws(() => validateEnvironmentAdapter(unknown), /未知字段/u)

  const invalidMemory = config()
  invalidMemory.spec.docker.resources.memory = '1tb'
  assert.throws(() => validateEnvironmentAdapter(invalidMemory), /内存值/u)

  const internet = config()
  internet.spec.task.allow_internet = true
  assert.throws(() => validateEnvironmentAdapter(internet), /未知字段/u)
})
