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
    this.nativeCodeCache = true
    this.verifierMetricNames = Object.freeze(['reference_ms', 'candidate_ms', 'speedup', 'correctness_trials', 'timing_rounds'])
    this.resultSemantics = 'kernelbench-correctness-v1'
    this.checkedGpuImages = new Set()
  }

  trialsResolved(trials) {
    // speedup/(1+speedup) 永远小于 1；正确性通过与是否加速分别表达。
    return trials.length > 0 && trials.every((trial) => trial.reward > 0 && !trial.solverFailure)
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
    const needsCompiler = task.config.metadata.tags.includes('requires-cuda-compiler')
    const needsTriton = task.config.metadata.tags.includes('requires-triton')
    const key = `${runtime.solverImage}:${task.config.environment.gpus}:${needsCompiler}:${needsTriton}`
    if (!this.checkedGpuImages.has(key)) {
      try {
        // 在付费模型请求之前，用真正的 Solver 镜像自检 PyTorch/CUDA。
        // 镜像构建阶段没有 GPU，不能用 Dockerfile HEALTHCHECK 代替此检查。
        await this.docker.run({
          image: runtime.solverImage,
          name: `kernelbench-gpu-check-${task.name}-${process.pid}`,
          command: ['/opt/conda/bin/python', '-c', [
            'import torch, shutil, importlib.util',
            'assert torch.cuda.is_available(), "CUDA unavailable"',
            'x=torch.ones(1,device="cuda"); assert x.sum().item()==1',
            ...(needsCompiler ? ['assert shutil.which("nvcc") and shutil.which("c++") and shutil.which("ninja"), "CUDA build tools unavailable"'] : []),
            ...(needsCompiler ? [
              'import subprocess, ctypes',
              'subprocess.run(["c++", "-shared", "-fPIC", "-x", "c++", "-o", "/kernel-cache/probe.so", "-"], input=b\'extern "C" int probe(){return 42;}\', check=True, capture_output=True)',
              'assert ctypes.CDLL("/kernel-cache/probe.so").probe() == 42, "native cache cannot load shared libraries"',
            ] : []),
            ...(needsTriton ? [
              'assert importlib.util.find_spec("triton"), "Triton unavailable"',
              'assert torch.cuda.get_device_capability(0) >= (7, 0), "Triton requires compute capability >= 7.0"',
            ] : []),
            'print("CUDA ready", torch.cuda.get_device_name(0), torch.cuda.get_device_capability(0))',
          ].join('; ')],
          environment: { HOME: '/tmp/home', PYTHONDONTWRITEBYTECODE: '1' },
          nativeCodeCache: true,
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
        if (/Triton requires compute capability|Triton unavailable/iu.test(stderr)) {
          throw new ProtocolError('该 KernelBench 任务要求 Triton 及 compute capability >= 7.0 的 GPU；请换兼容设备或选择 CUDA 任务')
        }
        if (/CUDA build tools unavailable/iu.test(stderr)) {
          throw new ProtocolError('该 KernelBench 任务要求 NVCC/C++/Ninja；请先构建 kernelbench-dev 镜像')
        }
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
