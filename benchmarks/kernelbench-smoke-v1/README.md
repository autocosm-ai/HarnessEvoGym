# KernelBench GPU Smoke

这是把 [KernelBench](https://github.com/ScalingIntelligence/KernelBench) L1 的两个单算子题接入 HarnessEvoGym 的最小示例。题目使用 Harbor 风格的任务树和 artifact 契约，但通过 `kernelbench-gpu-v1` 单独声明 GPU、正确性和性能评分能力。

当前只包含 ReLU 和 Sigmoid 两题，用来验证：任务镜像准备 -> Solver 修改 `model_new.py` -> GPU Verifier 检查数值正确性并测量 speedup -> 生成标准结果与 Checkpoint。输入形状按官方算子语义缩小为 smoke 规模，避免占满共享 GPU；它不是 KernelBench 全量复刻，也不包含官方完整的 CUDA/Triton 题库。

外部参考仓库默认放在本地 `ref-code/KernelBench`，被 `.gitignore` 忽略；可追溯版本见 Benchmark 的 `source.revision` 和本地任务文件摘要。

需要 NVIDIA Docker Runtime 和可用 GPU 时，可运行 `npm run test:kernelbench`，它会实际构建两道题的任务/Verifier 镜像，并验证 Solver 工作区、CUDA Verifier、标准结果和 Trial Checkpoint。该 Smoke 使用 no-op Solver，不调用模型 Provider；要验证 MSA Solver/Updater，则使用 `experiments/kernelbench-smoke-msa-single.json` 注入运行时凭据后启动正式 Experiment。
