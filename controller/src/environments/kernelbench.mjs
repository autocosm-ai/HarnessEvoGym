import { ProtocolError } from '../protocol.mjs'
import { HarborEnvironment } from './harbor.mjs'

/**
 * KernelBench 的最小 Environment Adapter。
 *
 * KernelBench 题目使用 Harbor 风格的隔离任务树，但这里单独暴露协议，
 * 让 GPU、正确性和性能评分成为 KernelBench 的环境契约，而不是把它误报
 * 成 OfficeVal 或普通 Harbor 任务。
 */
export class KernelBenchEnvironment extends HarborEnvironment {
  constructor(options) {
    super({ ...options, allowGpu: true })
    this.allowGpu = true
  }

  describeCapabilities() {
    return Object.freeze({
      apiVersion: 'harness-rsi/v1alpha1',
      environment: this.environment.id,
      partitions: Object.freeze(['feedback', 'selection', 'final']),
      supportsFeedback: true,
      supportsHiddenFinal: true,
      supportsTaskRetry: true,
      supportsCheckpointResume: true,
      scoreType: 'normalized-speedup',
      artifactType: 'kernel-source',
    })
  }

  async preflight() {
    const status = await super.preflight()
    for (const task of this.tasks.values()) {
      if (task.config.metadata.category !== 'kernelbench') {
        throw new ProtocolError(`KernelBench Task ${task.name} 必须声明 metadata.category=kernelbench`)
      }
      if (task.config.environment.gpus < 1) {
        throw new ProtocolError(`KernelBench Task ${task.name} 必须请求至少一张 GPU`)
      }
    }
    return status
  }
}
