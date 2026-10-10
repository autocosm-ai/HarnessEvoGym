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
    this.verifierMetricNames = Object.freeze(['reference_ms', 'candidate_ms', 'speedup', 'correctness_trials'])
    this.checkedGpuImages = new Set()
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

  async ensureRuntime(task = null) {
    const runtime = await super.ensureRuntime(task)
    if (!task) return runtime
    const key = `${runtime.solverImage}:${task.config.environment.gpus}`
    if (!this.checkedGpuImages.has(key)) {
      try {
        // 在付费模型请求之前，用真正的 Solver 镜像自检 PyTorch/CUDA。
        // 镜像构建阶段没有 GPU，不能用 Dockerfile HEALTHCHECK 代替此检查。
        await this.docker.run({
          image: runtime.solverImage,
          name: `kernelbench-gpu-check-${task.name}-${process.pid}`,
          command: ['/opt/conda/bin/python', '-c', 'import torch; assert torch.cuda.is_available(), "CUDA unavailable"; x=torch.ones(1,device="cuda"); assert x.sum().item()==1; print("CUDA ready")'],
          environment: { HOME: '/tmp/home', PYTHONDONTWRITEBYTECODE: '1' },
          inheritEnvironment: [],
          network: 'none',
          readOnlyRoot: true,
          capabilities: [],
          resources: { ...this.environment.verifier.resources, gpus: task.config.environment.gpus },
          timeoutMs: 60000,
        })
      } catch (error) {
        // --gpus 依赖宿主安装 NVIDIA Container Toolkit；缺失时 Docker 会以
        // "unknown flag: --gpus" 或 "could not select device driver" 失败。
        // 这类宿主缺少 GPU 运行时的问题必须与镜像内 CUDA 自检失败区分开，
        // 否则排查方向会被误导到模型或镜像上。
        const stderr = error.processResult?.stderr ?? ''
        if (/unknown flag: --gpus|could not select device driver|no such device/iu.test(stderr)) {
          throw new ProtocolError(
            '宿主 Docker 缺少 GPU 运行时（--gpus 不可用）；请安装 NVIDIA Container Toolkit 或改用 CPU Environment',
            [error.message],
          )
        }
        throw new ProtocolError('KernelBench Solver 镜像的 PyTorch/CUDA 自检失败；尚未开始模型调用', [error.message])
      }
      this.checkedGpuImages.add(key)
    }
    return runtime
  }
}
