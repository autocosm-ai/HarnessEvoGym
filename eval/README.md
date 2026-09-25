# 独立 OfficeVal 评测

这是 MSA Cowork 候选的兼容评测工具：复制冻结候选，在副本内替换带请求级重试的
`model.py`；逐题复制数据，Solver 和离线 Verifier 在容器中工作。
它不替代 Controller 的 sealed-final 审计链，也不支持 HLE 或任意 Solver。
训练流程和冻结候选不会被它修改。评分保持原独立脚本的 `total_score / max_score`，
允许负 reward；不要把它与 Controller 截到 0–1 的指标直接混用。

## 配置与运行

默认 `configs/cowork-main16.json` 保存原来 6 个版本、8 道题的设置，旧的
`--modes`、`--concurrency`、`--out` 参数继续有效。新实验使用自己的 JSON，
不需要改 Python 代码。配置必须包含 `version: 1`、`candidates`、`tasks`、`solver`。

```json
{
  "version": 1,
  "candidates": {
    "h0": {"workspace": "../population/branches/branch-001/run/candidates/h0/workspace"},
    "winner": {"best_report": "../population/report/best-harness.json"}
  },
  "tasks": ["officeval_011", "officeval_026"],
  "solver": {
    "model": "gpt-5.6-terra",
    "image": "harness-rsi/omegause-officeval:v1",
    "max_steps": 12,
    "max_output_tokens": 8192,
    "task_timeout_seconds": 3600
  }
}
```

候选支持三种来源：`workspace`；`best_report`；或 `population/branch/candidate`。
前两种相对路径以配置文件目录为基准；第三种相对 `RSI_POPULATIONS_ROOT`
（默认仓库 `.rsi/runs/populations`）。报告选择器根据报告中的 Branch/Candidate ID
定位同一 Population 下的候选，不依赖旧机器的 workspace 绝对路径。
`task_timeout_seconds: null` 可关闭整题超时；请求级重试仍有自己的上限。

运行时注入以下环境变量：

- `RSI_PROVIDER_API_KEY`、`RSI_PROVIDER_BASE_URL`：模型渠道。
- `RSI_OFFICEVAL_DATASET_ROOT`：包含 tasks 和 task_files 的数据集。
- `RSI_OFFICEVAL_EVALUATOR_ROOT`：包含 verifiers 的评测器目录。
- 可选 `RSI_SOLVER_IMAGE`、`RSI_RUN_VERIFIER`：覆盖镜像和仓库 verifier 入口。

```bash
python3 eval/run_eval.py --config /path/to/eval.json --out .rsi/eval/example --dry-run
python3 eval/run_eval.py --config /path/to/eval.json --out .rsi/eval/example
python3 eval/run_eval.py --config /path/to/eval.json --out .rsi/eval/example --resume
```

`--dry-run` 检查配置、候选、题目和 Verifier 文件；不需要 Key，不调用 Docker/API，
也不创建输出目录。它不验证镜像或上游连通性。实际运行会固定 Docker 镜像内容 ID。
输出目录必须与候选、数据集、评测器及脚本分离。

## 保存与续跑

- `run.json`：候选内容、题目、模型、endpoint、镜像和评测代码的指纹，不保存 Key。
- `<mode>/<task>/result.json`：每题结束后原子保存；中断不会抹掉前面的成功题。
- `<mode>/<task>/attempt-*/`：保留各次尝试的题目副本和产物。
- `summary.json`：逐个 Mode 更新；所有配置题目完成才给正式均分。

`--resume` 仅复用身份匹配且打分成功的题；失败题从该题开头重跑，
不支持恢复到题内某轮对话。Key 可以轮换，但候选、模型、输入或评测代码改变后需新建
输出目录。旧脚本只写 summary、没有 run.json 的历史结果不能自动迁移。
同一输出目录仅允许一个进程写入。不完整评测退出码为 2，正式均分为 null；
缺失、重复、非有限分数都不能被当成有效 0 分。

## 验证

`npm run test:eval` 使用临时小数据、假 Docker 和本地 HTTP 服务检查配置、
逐题落盘/续跑、隔离、分数完整性与断流重试，不启动真实实验或调用付费模型。
