# 统一冠军评测

`harness-rsi evaluate run` 只启动 Solver 和 Environment，不运行 Updater，也不重新训练。
支持标准 Experiment 的 OfficeVal、文本推理、HLE Docker 和 KernelBench 等环境。
原 HLE Campaign 的专用 sealed broker 保留；该入口使用新 `hle-text-math-docker-v1` 适配器。

## 探索评测

在配置中指定候选来源、Experiment、分区及输出目录。所有路径相对仓库根目录。

```json
{
  "apiVersion": "harness-rsi/v1alpha1",
  "kind": "EvaluationJob",
  "spec": {
    "mode": "exploratory",
    "experiment": "experiments/cowork-msa-smoke-single.json",
    "candidates": [
      {"id": "champion", "run": ".rsi/runs/populations/my-training"}
    ],
    "partition": "final",
    "output": ".rsi/evaluations/my-champion-v1",
    "model": {"model": "gpt-6.1-sol", "reasoningEffort": "medium", "maxTokens": 8192},
    "seeds": [1, 2],
    "infrastructureRetries": 5
  }
}
```

候选也可以使用 `workspace` 指向独立候选目录，或者在 `run` 后增加 `checkpoint`，指向该
Population 已登记的预算检查点（相对其 Run 目录）。检查点必须包含 `populationBest`。
候选源码只读使用，运行前后核对摘要；不会用本次测试分数重新选择训练冠军。

```bash
npm run rsi -- evaluate run --config evaluation-job.json --dry-run
npm run rsi -- evaluate run --config evaluation-job.json
npm run rsi -- evaluate run --config evaluation-job.json --resume
```

`--dry-run` 校验配置、候选及题目数量，不调用模型或构建镜像。实际执行仍会检查数据、镜像和
Provider。允许改变模型、Provider、超时等设置开展新评测，但必须使用新的输出目录。
`--resume` 只复用同一配置和内容身份下的已提交结果；失败题从该题重新开始。

`summary.json` 中某个候选失败时保持 `meanReward: null`、`status: incomplete`，其他候选继续。
只有所有候选完整完成时 `complete` 才是 true。不完整任务的 CLI 退出码为 2。
本入口的探索报告明确标记 `exploratory`，不能冒充原训练 Run 的正式封存测试结果。

## 正式封存评测

```json
{
  "apiVersion": "harness-rsi/v1alpha1",
  "kind": "EvaluationJob",
  "spec": {"mode": "sealed-final", "run": ".rsi/runs/populations/my-training"}
}
```

此模式转交原 `experiment finalize --final-only`，保留其冠军锁定、配置身份和 Claim 规则；
不接受模型等覆盖。`--resume` 转交已有的基础设施恢复授权，不创建无限次新的 Final Claim。
多组共用 H0 的正式评测仍使用 `experiment finalize-suite`。

## OfficeVal 旧工具迁移

新评测应使用公共入口；旧 `eval/` 继续用于重放历史独立脚本结果，不删除历史数据。

- `meanReward`：Controller 的归一化评分，范围 0～1，并包含 Dim1 门槛。
- `rawMean` / `rawMetric=officeval-raw-ratio-v1`：各题原始 `total_score/max_score` 的均值，可以为负。
- 只有所有题都保留有效原始分数时才提供 `rawMean`；旧检查点缺少该字段时保持 null。

两种分数明确分开，不把历史负分静默截成 0 后声称复现了旧结果。

## 验收与限制

`npm run demo` 不需要 Key、Docker 或私有数据，使用真实 Population、Candidate Diff、检查点和公共评测。
Solver 与 Updater 是仓库内的受信离线替身，不代表真实模型能力，也不提供任意代码的宿主隔离。
命令会启动三个先后退出的进程，分别执行一轮、恢复剩余轮次、评测冠军。

真实实验可使用 `experiment run --round-limit 1` 在一个 Population wave 后退出，再用
`experiment resume` 恢复。这个上限控制本次进程推进多少波，不改变原实验总预算。
只有实验中确实发生代码修改并执行模型/Verifier，才算真实进化验收。

## 真实小规模验收

这些命令使用真实模型，产生 API 费用；普通 `npm test` 和 CI 不会自动执行。
先按 README 配好 Provider，并安装 Docker。OfficeVal 还需按
[运行手册](cowork-mvp.zh.md) 准备原始数据、评测器及对应的路径环境变量。

```bash
npm run rsi -- experiment validate --config experiments/cowork-msa-acceptance.json
npm run test:acceptance -- --config experiments/cowork-msa-acceptance.json --run-id office-acceptance-001 --dry-run
npm run rsi -- runtime build --experiment experiments/cowork-msa-acceptance.json
npm run test:acceptance -- --config experiments/cowork-msa-acceptance.json --run-id office-acceptance-001
```

`--dry-run` 仅校验验收配置，不构建镜像、不调用模型、不创建 Run 或证据目录。
该配置使用 MSA Docker Solver、DSH Docker Updater、`gpt-6.1-sol / medium` 和独立 Verifier。
`msa-minimal-cowork-rsi.yml` 允许 12 步交互；不要换成仅允许一步的 `msa-minimal.yml`，
后者只能验证连通性，模型可能刚检查完文件就结束。三个分区各一题，单 Branch，预算 B2，
L1 变异。验收沿用宽松的 smoke 晋升门槛，同分候选也可能晋升；这不是证明能力提升的实验。

HLE 需要先下载有权使用的 Parquet 数据，并在项目自己的 Python 环境安装 `pyarrow`。
以下输入路径是示例，`--source` 和 `--revision` 必须填写实际数据来源及版本：

```bash
python scripts/import-hle-parquet.py \
  --input .local/datasets/hle/test.parquet \
  --output .rsi/hle-acceptance/eligible.jsonl \
  --source YOUR_DATASET --revision YOUR_REVISION
node scripts/prepare-hle-docker.mjs \
  --input .rsi/hle-acceptance/eligible.jsonl \
  --source YOUR_DATASET --revision YOUR_REVISION \
  --output .rsi/hle-acceptance/run --per-partition 1
npm run rsi -- runtime build --experiment .rsi/hle-acceptance/run/experiment.json
npm run test:acceptance -- --config .rsi/hle-acceptance/run/experiment.json --run-id hle-acceptance-001
```

脚本按 source ID 哈希排序选题，生成互不重叠的 feedback、selection 和 final 分区，
不会按模型得分挑题。来源记录和含答案数据留在被忽略的 `.rsi/` 中，不要提交。

`test:acceptance` 会启动独立 CLI 进程，在 B1 保存后退出，恢复到 B2，再通过公共
`evaluate run` 评测训练冠军，最后用 `--resume` 检查结果复用。
证据位于 `.rsi/acceptance-results/<run-id>/`：`start.log`、`resume.log`、
`evaluation/summary.json`、`evaluate-resume.log` 和 `acceptance.json`。
只有整条链完成后才写 `acceptance.json`；只看到目录或 B2 状态不等于验收通过。
每次新实验使用新的 Run ID。失败时保留已有目录，先诊断并恢复原运行，不要删除记录来伪装重试成功。

这里的 final 指独立测试分区，评测模式仍是 `exploratory`，不替代正式 `sealed-final` 审计。
两次变异、每个分区一题只证明工程链路可运行；要报告提升，还需更多题目、重复实验和正式协议。

2026-10-29 的两组真实验收均完成 B1 退出、B2 恢复、冠军评测及结果复用。HLE 使用明确标注来源的
公开镜像，OfficeVal 中途有一次重复输出后的人工续跑；完整记录及分数见
[开发日志](../README.dev.zh.md#2026-10-29真实-b2-验收完成与诊断修复)。
