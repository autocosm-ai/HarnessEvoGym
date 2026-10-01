# KernelBench L1 Sigmoid

在当前工作区优化 `model_new.py`，使 `ModelNew` 在保持与 `reference.py` 数值一致的前提下尽可能快。
只能修改 `model_new.py`，不要修改参考实现。完成后保留可导入的 `ModelNew` 类；Verifier 会在 GPU 上执行正确性和性能测试。

运行环境有 PyTorch 2.1.2 和 CUDA 11.8，可用 GPU 上自测；此 smoke 镜像没有 NVCC，
不要联网安装依赖，不要假设 Triton 支持当前 GPU 架构。输入不可原地修改。
先读取参考实现并做数值自检，再尝试优化。速度分数为 speedup / (1 + speedup)，
其中 speedup = 参考耗时 / 候选耗时；数值错误记 0 分，等速约 0.5 分。
