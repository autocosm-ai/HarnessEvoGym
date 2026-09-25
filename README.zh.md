<p align="center">
  <picture>
    <source media="(prefers-reduced-motion: reduce)" srcset="docs/assets/harness-evo-gym-hero.png" />
    <img src="docs/assets/harness-evo-gym-loop.gif" width="100%" alt="HarnessEvoGym 将 Target、Environment 和 Evolution Recipe 组合成可信的 Harness 自进化闭环。" />
  </picture>
</p>

<h1 align="center">HarnessEvoGym</h1>

<p align="center">
  <strong>一个让 Agent Harness 自我改进，而且改得可测、可控、可复现的实验场。</strong>
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="docs/architecture.zh.md">架构</a> ·
  <a href="CONTRIBUTING.md">Contributor 开发指南</a>
</p>

<p align="center">
  <img alt="状态为研究预览版" src="https://img.shields.io/badge/status-research_preview-f4a261?style=flat-square" />
  <img alt="Controller 使用 MIT 许可证" src="https://img.shields.io/badge/controller_license-MIT-4c8bf5?style=flat-square" />
  <img alt="支持五种种群模式" src="https://img.shields.io/badge/population_modes-5-8b5cf6?style=flat-square" />
  <img alt="Node 与 Python 测试" src="https://img.shields.io/badge/tests-Node_%2B_Python-20a36a?style=flat-square" />
</p>

HarnessEvoGym 把 Harness 自进化变成一个可以审计的实验：**优化谁、在哪里做题、
用什么算法进化**可以独立配置；冻结的 Controller 负责权限、评测、晋升、回滚和谱系，
不会把“选手”和“裁判”混在一起。

~~~
Target × Environment × EvolutionAlgorithm × EvolutionRecipe
~~~

同一套种群算法既能让 MSA Minimal 在真实 Office 任务上进化，也能验证 Reasoning
链路；以后接入新的 Harness 或 Benchmark，只需要实现 Adapter，不需要重写 Controller。

## 为什么要做 HarnessEvoGym

让 Coding Agent 修改自己的代码并不难，难的是证明“改完真的更好”。一个可信的
RSI 闭环至少要防止 Candidate 修改裁判、偷看隐藏题、写出授权目录，或者因为一次随机
平分就被误判为进化成功。

HarnessEvoGym 把这些要求做成了硬边界：

| 核心问题             | HarnessEvoGym 的做法                                              |
| -------------------- | ----------------------------------------------------------------- |
| **允许改什么？**     | Target 声明 Region，Controller 翻译成单轮 MutationLease          |
| **谁来修改？**       | 可插拔 Updater，例如 Codex CLI 或 DeepSeek Harness                |
| **怎么证明提升？**   | Environment 提供题目、Verifier、指标和严格晋升 Gate              |
| **下一轮搜哪里？**   | Population Topology 与独立 SearchStrategy 共同决定                |
| **什么永远不能改？** | Controller、Gateway、Evaluator、Split、凭据和封存测试集           |

## 四层模型

| 层                    | 负责什么                                                            | 不负责什么                         |
| --------------------- | ------------------------------------------------------------------- | ---------------------------------- |
| **Target**            | Harness 源码、H0 起点、Runtime、Validator、可变 Region              | 题目、分数和晋升规则               |
| **Environment**       | 题目、隔离工作区、Verifier 和指标                                   | Candidate 文件写权限               |
| **Evolution Recipe**  | Mode、Branch、Budget、经验共享和模块搜索                             | 某个 Harness 的具体文件路径        |
| **Controller**        | 调度、MutationLease、Diff Guard、谱系、晋升和回滚                   | 可以被 Updater 修改的解题策略       |

一轮 Candidate 进化流程是：

~~~
Champion
  -> SearchStrategy 从 Target Catalog 选择 Region ID
  -> Controller 发放 MutationLease
  -> Updater 分析 Bad Case，并修改一个新 Candidate
  -> Controller 重新计算完整 Diff，执行路径与语义校验
  -> Solver 做 feedback + selection 题
  -> 严格 Gate 通过则晋升，否则继续保留原 Champion
~~~

Prompt 负责告诉 Updater“为什么改、怎么分析”；MutationLease、Validator 和 Diff Guard
负责硬性限制“到底能改哪里”。安全边界不依赖 Updater 自觉。

## 当前已经支持什么

| 能力                  | 当前实现                                                          |
| --------------------- | ----------------------------------------------------------------- |
| Harness Target        | MSA Minimal Cowork、MSA Minimal Reasoning、DeepSeek Harness 路径 |
| Updater               | 隔离的 Codex CLI 0.149.1、DeepSeek Harness                       |
| Environment           | OmegaUse-OfficeVal、Synthetic Reasoning、HLE/Putnam 路径         |
| Population Topology   | Single、Independent、Mutualism、Competition、Combined            |
| Module Search         | Linear Hill Climb、Progressive Risk Expansion、Docker Strategy API |
| 风险分层              | 每个 Target 自己定义 L1/L2/L3 和对应文件                         |
| 可靠性                | Provider 重试、逐题断点、显式 Resume、一次性 Sealed Final        |

真实 Cowork 使用
[OmegaUse-OfficeVal](https://github.com/baidu-frontier-research/OmegaUse-OfficeVal)。
上游 100 道题中，目前有 91 道注册了 Linux 执行链路：
**55 道 feedback/train + 18 道 selection/validation + 18 道一次性 sealed final**。
Solver 只看到题目和原始 Office 输入；评分在另一个只读 Verifier 容器中离线完成。

Synthetic Text Reasoning 只是链路冒烟，不是 HLE 成绩。PI Agent 目前只是 Adapter
示例，不是已经跑通的 Target。对外引用结果前，请先阅读
[当前能力边界](docs/architecture.zh.md#已实现路径与当前边界)。

## 五种种群模式

| Mode              | Branch 怎么运行                                           |
| ----------------- | --------------------------------------------------------- |
| `single`          | 一个 Branch 独占全部 Candidate Budget                    |
| `independent`     | 多 Branch 独立搜索，彼此不共享历史                       |
| `mutualism`       | 独立搜索，同时只读其他 Branch 的进化证据                 |
| `competition`     | 多 Branch 竞争额外 Candidate Budget                       |
| `combined`        | 同时开启经验共享与 Budget 竞争                            |

Mode 和模块搜索互不冲突。例如
`combined + linear-hill-climb` 与
`combined + progressive-risk-expansion` 都是合法组合。

## 快速开始

需要 Linux、Docker、Node.js 20+、npm 和 Git。

~~~bash
git clone https://github.com/DeepThinkingZhouLiu/HarnessEvoGym.git
cd HarnessEvoGym
npm ci
npm run check
npm test
~~~

下面的命令只校验完整配置，不会请求真实模型：

~~~bash
npm run rsi -- experiment validate \
  --config experiments/reasoning-msa-progressive-strict-smoke.json
~~~

真实运行只允许在 Runtime 注入凭据：

~~~bash
export RSI_PROVIDER_BASE_URL=https://provider.example/v1
read -rsp 'Provider API Key: ' RSI_PROVIDER_API_KEY
export RSI_PROVIDER_API_KEY

npm run rsi -- runtime build \
  --experiment experiments/reasoning-msa-progressive-strict-smoke.json
npm run rsi -- experiment run \
  --config experiments/reasoning-msa-progressive-strict-smoke.json \
  --run-id reasoning-progressive-001

unset RSI_PROVIDER_API_KEY
~~~

不要把真实 Key 写进 Experiment、Adapter、Candidate、Trace 或 Git。OfficeVal 的数据
准备、Task Image、断点恢复和 Sealed Final 操作见
[Cowork 运行手册](docs/cowork-mvp.zh.md)。

只想比较隐藏测试分数时使用 `experiment finalize --run <run> --final-only`：
它跳过 H0/Champion 的训练题回放，只跑冻结 H0 与冠军的 final，训练—测试提升差距
留空，不重新训练或重新选择冠军。OmegaUse Final 默认对**尚未完成的题**最多追加
5 次接口故障重试，等待 5/10/20/40/60 秒；可用 `--infrastructure-retries 0..10`
调整（默认 5）。HTTP 200 响应内的 error、连接中断以及暂态 HTTP 错误可触发重试，明确的
401/403、配置错误、Verifier 故障、正常空回答/拒答/工具协议问题和合法零分不会触发。
重试先归档失败题的半成品与诊断，再从干净工作区重做该题；已提交的题不重跑。
这是**同一次 Final Claim 内**的有界重试，不是跨进程 Final Resume；重试耗尽仍失败，
不会生成伪造分数，也不会删除 Claim 或放开重复解封。只对声明按题断点能力的
OmegaUse 生效，旧 Environment 保持原行为。详见 [Final 容错说明](docs/final-evaluation-retry.zh.md)。

多 Mode 比较使用 `experiment finalize-suite --config <shared-final.json>`：只测一份共享
H0 和每个 Mode 的冻结冠军，复用同一份 H0 分数；不重新训练。新 Suite 支持固定身份下
按题 `--resume`、持久化重试预算和显式空正文兼容，旧 Final 入口规则不变。
详见 [共享 H0 最终评测](docs/shared-final-suite.zh.md)。

Reasoning 的 Synthetic Text 五 Mode 仍只是工程冒烟。HLE 正式实验必须先准备门控
`cais/hle` 数据、sealed split、固定 MSA Source 与专用 Runtime；这些条件缺失时，
不能把 Synthetic 结果替代为正式 Reasoning 成绩。

当前通用 Population 的边界也需要明确：基础设施异常会被标成
`PAUSED_INFRASTRUCTURE` 并让命令失败，绝不会冒充 0 分成功结束。Cowork Population 可以用
`experiment resume --run <population-run>` 在同一个 Controller Revision 下继续；恢复时会重验冻结
Bundle、Source、Candidate Digest 和 Mutation 边界，并把未完成轮次归档到 `recovery/`
后重跑。OmegaUse 会进一步按题读取原子提交的 `committed-result.json`：已经完成的题目
（包括合法 0 分）直接复用，只运行没有完成的题目；半成品会先移入 `recovery/trial-attempts/`
保留审计证据。进化阶段的基础设施失败不会在同一命令里自动重跑整题，必须由用户显式执行 Resume，
失败尝试的 Token/时间仍计入 Ledger。普通进化恢复必须是同一 Controller
Revision；只有上述“尚未访问 sealed final”的 Final Recovery 可以在显式参数下使用一个
继承原 Revision 的新 Controller，并同时记录进化版本和 Finalizer 版本。修改冻结配置后仍必须
使用新 Run ID。Model Gateway 的请求上限目前按 Branch 生效，还不是整个 Population 的全局费用上限。
生产 HLE/PutnamBench 继续使用原有的恢复、
sealed test 与 Final 链路，不能把这里的公开 Smoke 替代为正式评测。

## 已注册的五 Mode Cowork 正式配置

仓库已经提供一套固定的正式训练配置：

| 配置项                  | 当前值                                                    |
| ----------------------- | --------------------------------------------------------- |
| Target / Solver         | MSA Minimal Cowork，完整 12 步 Runtime                   |
| Updater                 | 隔离的 Codex CLI 0.149.1                                 |
| Solver + Updater 模型   | `gpt-5.6-terra`，High 思考深度，8192 Output Token        |
| 搜索空间                | L1 Prompt/Skill + L2 Agent Loop/Tool Runtime             |
| 搜索策略                | `linear-hill-climb`                                      |
| Candidate Budget        | 每个 Mode 32 次                                          |
| Branch                  | Single = 1；其他四种 Mode = 2                            |
| 并发                    | 最多并行 2 个 Mode；每个 Branch 并行 2 道 Office 题      |
| 数据                    | 55 道 feedback + 18 道 selection；final 继续封存         |
| Seed / Trial            | 一个预注册 Seed，每题一个 Trial                          |

五份 Experiment 位于
[`experiments/cowork-msa-rsi-formal32-codex-*.json`](experiments/)，统一调度脚本位于
[`scripts/run-cowork-formal32-five-mode.mjs`](scripts/run-cowork-formal32-five-mode.mjs)。

~~~bash
export RSI_OFFICEVAL_DATASET_ROOT=/absolute/path/to/OmegaUse-OfficeVal-Dataset
export RSI_OFFICEVAL_EVALUATOR_ROOT=/absolute/path/to/OmegaUse-OfficeVal
export RSI_SUITE_MAX_CONCURRENT_MODES=2

node scripts/run-cowork-formal32-five-mode.mjs
~~~

这是一套完整的 RSI 配置，但还不是统计意义上的论文结论。正式比较需要预注册多个
Seed/Trial，并同时报告 Reward、Solver/Updater Token、墙钟时间、基础设施失败和一次性
Sealed Final 结果，不能只挑最高分。

## 怎么接入自己的组件

- 想优化新的 Harness，就新增 **Target**：实现 Source、CandidateSeed、Solver Driver、
  Semantic Validator 和 Mutation Catalog。

- 想增加新的任务领域，就新增 **Environment**：实现题目物化、隔离、Verifier、Result
  协议、Split 和主指标。

- 想增加新的模块选择算法，就新增 **SearchStrategy**：它只能返回 Region ID，不能返回
  文件路径、凭据或隐藏评测信息。

- 想扩展种群编排，就注册 **EvolutionAlgorithm**：目前须兼容现有 PopulationStore、
  状态格式和 Branch/Budget 契约。通过可信启动脚本注册；尚不支持任意外部算法或状态格式。

- 想重新组合 Mode、Branch、Budget、共享规则和搜索策略，就新增
  **EvolutionRecipe**，不需要改 Controller 主循环。

完整目录图、术语、协议、扩展步骤、测试矩阵和 PR Checklist 都在
[Contributor 开发指南](CONTRIBUTING.md)。

独立 [OfficeVal 评测工具](eval/README.md) 可配置候选、题目和模型，并支持复用已完成题目的
分数继续评测。它是兼容工具，不生成 Controller 的 sealed-final 审计链。
修改后运行 `npm test`、`npm run check` 和 `npm run test:eval`。

## 信任与可复现性

- Controller、Gateway、Evaluator、隐藏 Split、凭据和 Promotion Policy 永远在
  Candidate 可写范围之外。

- Target Source、CandidateSeed、Updater Distribution、Benchmark Source 和展开后的
  Experiment Bundle 都会固定 Revision 或内容摘要。

- Solver、Updater、Verifier、外部 SearchStrategy 使用不同的隔离边界和最小权限挂载。

- Provider 或 Verifier 故障会暂停实验，不会伪装成 0 分；Resume 只复用已经原子提交的
  逐题结果。

- Sealed Final 在进化期间不可见，只能在全局 Best Candidate 锁定后开启一次。

## 文档导航

| 你想了解什么                  | 对应文档                                                  |
| ----------------------------- | --------------------------------------------------------- |
| 信任边界与总体架构            | [架构说明](docs/architecture.zh.md)                       |
| Mode、Branch 与 Budget        | [Controller 五种模式](docs/controller-modes.zh.md)        |
| Region 与 SearchStrategy      | [搜索空间与搜索策略](docs/search-strategy.zh.md)          |
| 如何运行 Cowork 实验          | [OmegaUse Cowork 手册](docs/cowork-mvp.zh.md)             |
| 如何开发、扩展和提交 PR       | [Contributor 开发指南](CONTRIBUTING.md)                   |

本仓库 Controller 使用 [MIT License](LICENSE)。Vendored Source 与 Submodule 保留
各自许可证和 NOTICE。
