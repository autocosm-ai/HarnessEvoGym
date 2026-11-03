# KernelBench 原始任务与 CUDA 开发环境

旧 `kernelbench-smoke-v1` 继续保留缩小形状的 ReLU/Sigmoid 连通性样例。
新导入入口直接读取固定上游 Git 提交的原文件，不修改输入形状；默认选择两个 L1 矩阵乘法和
一个 L2 Matmul/Scaling/ResidualAdd 任务，分别用于 feedback、selection、final。
三个任务仅用于小规模工程验收，不代表完整 KernelBench 或可靠泛化结论。

## 准备

需要 Linux、NVIDIA 驱动和 NVIDIA Container Toolkit。构建镜像含 PyTorch 2.1.2、
CUDA 11.8、NVCC、C++ 和固定版本 Ninja；基础镜像固定内容摘要。
Solver 与 Verifier 只在独立的 `/kernel-cache` 内允许加载编译产物，该内存盘上限为 1 GiB，
计入容器内存，容器结束后删除。普通临时目录维持原策略；运行前会实际编译并加载一个小型动态库。

```bash
git clone https://github.com/ScalingIntelligence/KernelBench.git ref-code/KernelBench
git -C ref-code/KernelBench checkout 423217d9fda91e0c2d67e4a43bf62f96f6d104f1
docker build -t harness-rsi/kernelbench-dev:v1 docker/kernelbench-runtime
node scripts/prepare-kernelbench.mjs \
  --source ref-code/KernelBench --output .rsi/kernelbench-cuda
npm run rsi -- experiment validate --config .rsi/kernelbench-cuda/experiment.json
```

输出目录必须是新的 `.rsi/` 子目录。生成的 `provenance.json` 记录上游版本、文件摘要和
任务树摘要，并保留上游许可证。读取的是提交里的文件，工作区中未提交的参考实现不会混入实验。
正式使用前应检查所选任务的内存需求；不同任务可通过 `prepareKernelBench()` 的 `tasks` 参数指定。

## 验证

```bash
npm run test:kernelbench:cuda
```

该命令不调用模型，使用明确的 Solver 夹具：实际 NVCC 编译 CUDA 矩阵乘法，运行三分区、
多 seed、检查点复用，并注入错误实现验证零分分类。默认 `npm test` 只做离线契约测试，
GPU 验收需要显式执行。不能把夹具分数当作训练提升。

真实 MSA Solver / DSH Updater 仍走标准 Experiment：

```bash
npm run rsi -- doctor --config .rsi/kernelbench-cuda/experiment.json
npm run rsi -- runtime build --experiment .rsi/kernelbench-cuda/experiment.json
npm run test:acceptance -- --config .rsi/kernelbench-cuda/experiment.json --run-id kernelbench-acceptance-001
```

最后一条会调用配置中的真实模型并产生费用，执行 B1 保存、跨进程恢复至 B2、冠军测试及复用。
每个分区只有一题，晋升使用 smoke 策略；即使完整跑通也只证明工程闭环。

## 评分与边界

参考实现先自检，候选使用相同初始化权重。三组输入检查类型、形状、数值和输入未被改写；
编译与预热排除在测速之外，参考与候选交替测速五轮，取各自中位数。
`speedup = reference_ms / candidate_ms`，归一化奖励为 `speedup / (1 + speedup)`。
正确性通过时 `status=resolved`；是否加速看 speedup 是否大于 1，二者不能混为一谈。
数值错误记零，参考实现或可信运行环境失败才暂停。原始耗时和速度比保存在 verifier CTRF 中。

例如 P40 属于 compute capability 6.1，可运行这里的 CUDA 路径；Triton 需要支持的 GPU 架构。
带 `requires-triton` 的任务会在模型调用前检查包和 compute capability，低于 7.0 时拒绝启动。
本轮不能把 P40 的 CUDA 验收称为 Triton 验收。

候选 Python 仍在隔离 Verifier 容器里被导入。数值、输入修改与异常检查不是针对恶意
benchmark cheating 的形式化证明；该适配器目前保持实验性定位。
