<h1 align="center">HarnessEvoGym</h1>

<p align="center">
  <strong>让 Agent Harness 自己进化，但始终在可复现、可审计的边界内。</strong>
</p>

<p align="center">
  HarnessEvoGym 是一个面向 Agent Harness 的 RSI（Recursive Self-Improvement）训练场。<br />
  选择<strong>什么进化</strong>、<strong>在哪里验证</strong>、<strong>如何搜索</strong>作为独立组件，<br />
  而 Controller 负责权限、评测、晋升、回滚和血统追踪。
</p>

<p align="center">
  <sub>北京大学 DCAI 团队 / OpenDCAI 与 AutoCosm.AI 联合开发 · <a href="https://github.com/OpenDCAI"><img src="docs/assets/logos/opendcai.png" height="16" alt="OpenDCAI" /></a> <a href="https://github.com/autocosm-ai"><img src="docs/assets/logos/autocosm-ai.png" height="16" alt="AutoCosm.AI" /></a></sub>
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="docs/architecture.zh.md">架构</a> ·
  <a href="CONTRIBUTING.md">贡献指南</a> ·
  <a href="README.dev.zh.md">开发日志</a>
</p>

<p align="center">
  <img alt="研究预览版" src="https://img.shields.io/badge/status-research_preview-f4a261?style=flat-square" />
  <img alt="MIT License" src="https://img.shields.io/badge/controller-MIT-4c8bf5?style=flat-square" />
  <img alt="五种 Population Mode" src="https://img.shields.io/badge/population_modes-5-8b5cf6?style=flat-square" />
  <a href="https://github.com/autocosm-ai/HarnessEvoGym/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/autocosm-ai/HarnessEvoGym/actions/workflows/ci.yml/badge.svg" /></a>
</p>

---

**核心能力**

| 你控制什么 | 它如何工作 |
| --- | --- |
| **Target** | 选择进化的 Harness：MSA Minimal Cowork、MSA Minimal Reasoning 或 DeepSeek Harness 路径 |
| **Environment** | 在真实任务上验证：OmegaUse-OfficeVal 或 HLE Text-only Math |
| **Evolution** | 五种 Population Mode（single、independent、mutualism、competition、combined）+ 可插拔搜索策略 |
| **Trust** | Controller、评测器、隐藏 split、凭据和晋升策略不属于 Candidate 可写集 |

```text
Target × Environment × EvolutionAlgorithm × EvolutionRecipe
```

## 它解决什么问题

让一个 Coding Agent 修改自己的代码并不难；难的是判断修改是否真的有效，并且保证它不能修改裁判、偷看隐藏题、污染数据集或把一次网络故障伪装成能力提升。

HarnessEvoGym 把这些边界做成 Controller 可以执行的协议：

| 关注点         | Controller 的做法                                                                 |
| -------------- | --------------------------------------------------------------------------------- |
| **修改什么**   | Target 声明 Mutation Region，Controller 为每一轮发放一次性 Mutation Lease         |
| **谁来修改**   | Codex CLI、Claude Code、DeepSeek Harness 等完整 Coding Agent Session             |
| **在哪里验证** | Environment 独立物化任务、工作区和 Verifier                                       |
| **如何搜索**   | Population Mode 与 SearchStrategy 解耦，可复用、可替换                            |
| **如何决定**   | 只用受信 validation 结果做晋升；失败的基础设施进入暂停和 Resume                   |

## 进化闭环

一轮进化的实际链路：

<p align="center">
  <img src="docs/assets/harness-evo-gym-loop-v2.png" width="720" alt="HarnessEvoGym 的 Candidate、Environment、Solver、Verifier 和 Updater 闭环。" />
</p>

<p align="center">
  <sub><em>Champion → 选择 Region → 发放 MutationLease → Updater 修改 Candidate → Diff 校验 → Solver 执行任务 → Verifier 评分 → 晋升门决策</em></sub>
</p>

```text
固定 Source 与 H0
      ↓
SearchStrategy 选择父 Candidate 与可变 Region
      ↓
Controller 发放 Mutation Lease
      ↓
Updater 读取反馈，修改 Candidate 并提交变更
      ↓
Controller 检查 Diff、资源、语义和权限边界
      ↓
Solver 在 validation 题上执行
      ↓
Verifier 计算 Reward
      ↓
严格提升 → 晋升；否则 → 回退；基础设施故障 → 暂停并 Resume
```

Updater 保留完整的分析、假设、自检和编码过程；Controller 不把它拆成固定的微操作，只负责把"能改什么、在哪里改、如何评测"锁死。

## 当前稳定支持

**环境**

- **OmegaUse-OfficeVal**：91 个 Linux 兼容任务（55 feedback/train + 18 selection/validation + 18 sealed final）。Solver 只接收任务描述和原始 Office 输入；评分在独立的只读 Verifier 容器中离线运行。
- **HLE Text-only Math**：text-only Math 子集，使用固定 revision、分层抽样和 sealed test 规则。Runtime 和 sealed broker 独立；详见 [当前边界](docs/architecture.zh.md#已实现路径与当前边界)。

**Target 与 Updater**

| Target                 | Updater 选项                           | 搜索空间                            |
| ---------------------- | -------------------------------------- | ----------------------------------- |
| MSA Minimal Cowork     | 隔离 Codex CLI、Claude Code CLI        | L1 prompt/skills + L2 agent loop/tool runtime |
| MSA Minimal Reasoning  | 隔离 Codex CLI、Claude Code CLI        | L1 prompt/skills + L2 agent loop/tool runtime |
| DeepSeek Harness path  | DeepSeek Harness                       | DeepSeek 特定模块                   |

**Population 与搜索**

| 能力       | 选项                                                                      |
| ---------- | ------------------------------------------------------------------------- |
| Population | Single、Independent、Mutualism、Competition、Combined                     |
| 模块搜索   | Linear hill climb、Progressive risk expansion、Docker strategy API        |
| 可靠性     | Provider 重试、按任务 Checkpoint、显式 Resume、sealed Final               |
| 诊断       | Run 进度与用量记录、Updater 失败报告、Diff 检查和按层级调整的超时          |

Harbor、SWE-bench、PutnamBench 和 Synthetic Text Reasoning 保留为实验性或兼容路径，暂不属于稳定支持承诺。报告结果前请查阅 [当前边界](docs/architecture.zh.md#已实现路径与当前边界)。

## 快速开始

**安装并校验**

需要 Linux、Docker、Node.js 20+、npm 和 Git。

```bash
git clone https://github.com/autocosm-ai/HarnessEvoGym.git
cd HarnessEvoGym
npm ci
npm run check
npm test
npm run test:eval
```

**只校验配置，不调用模型**

```bash
npm run rsi -- experiment validate \
  --config experiments/reasoning-msa-progressive-strict-smoke.json
```

**准备运行时凭据**

真实运行只在运行时注入凭据。任何密钥不能写入 Experiment、Adapter、Candidate、Trace 或 Git。

```bash
export RSI_PROVIDER_BASE_URL=https://provider.example/v1
read -rsp 'Provider API Key: ' RSI_PROVIDER_API_KEY
export RSI_PROVIDER_API_KEY

npm run rsi -- runtime build \
  --experiment experiments/reasoning-msa-progressive-strict-smoke.json
npm run rsi -- experiment run \
  --config experiments/reasoning-msa-progressive-strict-smoke.json \
  --run-id reasoning-progressive-001

unset RSI_PROVIDER_API_KEY
```

真实运行前还要按环境准备数据集和 Runtime：

- OfficeVal：阅读 [`docs/cowork-mvp.zh.md`](docs/cowork-mvp.zh.md)
- HLE：阅读 [`benchmarks/hle-text-math/README.zh.md`](benchmarks/hle-text-math/README.zh.md)

## Population Mode 与扩展点

**五种 Population Mode**

| Mode          | Branch 行为                                    |
| ------------- | ---------------------------------------------- |
| `single`      | 一个 Branch 消耗完整 Candidate budget          |
| `independent` | 多个 Branch 独立搜索，不共享历史               |
| `mutualism`   | 独立搜索，同时读取只读的 peer evolution evidence |
| `competition` | Branch 竞争额外的 Candidate budget pool        |
| `combined`    | 同时启用 peer sharing 与 budget competition    |

Population Mode 与 Module Search 正交。例如，`combined + linear-hill-climb` 和 `combined + progressive-risk-expansion` 是两种不同的有效组合。

**扩展平台**

- 添加 **Target**：实现 Target Adapter，声明 Source、CandidateSeed、Validator 和 Mutation Catalog。
- 添加 **Environment**：实现 Environment Adapter，提供任务物化、隔离工作区、Verifier、指标和数据划分。
- 添加 **SearchStrategy**：实现 SearchStrategy，只返回受信 Catalog 中的 Region ID 和父 Candidate。
- 注册 **EvolutionAlgorithm**：Population Recipe 目前要求受信驱动遵守 PopulationStore/Branch/Budget 契约。Beam、MCTS 等独立算法可以通过 `harness-rsi algorithm run` 使用 SDK v2 的 `initialize/step/resume/report` 生命周期和自己的 RunStore/Checkpoint；这条通用路径目前还没有接入标准 Experiment Recipe 或 Server Run API。
- 添加 **EvolutionRecipe**：重组现有 Population 拓扑、Branch 数量、预算、共享规则和搜索策略。

完整接口、协议边界、测试矩阵和 PR 要求见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

## 高级主题

**注册的五种模式 Cowork 套件**：仓库包含固定的正式训练配置（每种 Mode 32 个 Candidate，`linear-hill-climb`，MSA Minimal Cowork + OfficeVal）。详见 [`experiments/cowork-msa-rsi-formal32-codex-*.json`](experiments/) 和 [`scripts/run-cowork-formal32-five-mode.mjs`](scripts/run-cowork-formal32-five-mode.mjs)。

**共享 Final 评测**：对于跨模式比较，`experiment finalize-suite` 评测一个共享的 H0 和每个冻结的 Champion，不重新训练。详见 [共享 final 评测](docs/shared-final-suite.zh.md)。

**Server API / Core Engine**：`server/` 负责创建 Run、查询状态、Resume/Cancel、事件流和版本摘要；`controller/src/` 继续作为 Core Engine，负责受信实验执行。Population Run 可以通过 `POST /v1/runs/:runId/fork` 从已提交 Checkpoint 创建新 Run。详见 [`server/README.zh.md`](server/README.zh.md)。

**独立评测器**：独立的 [OfficeVal 评测器](eval/README.md) 接受 candidate/task/model 配置，可以 resume 已完成的任务分数。它是兼容性运行器，独立于 Controller 的 sealed-final 审计链。

## 信任与可复现性

- Controller、Gateway、评测器、隐藏 split、凭据和晋升策略不属于 Candidate 可写集。
- Target Source、CandidateSeed、Updater 分发包、Benchmark source 和展开的 Experiment bundle 使用内容寻址或 revision 固定。
- Solver、Updater、Verifier 和外部 SearchStrategy 使用不同的隔离和最小权限挂载运行。
- Provider 或 Verifier 失败会暂停实验，而不是伪装成零分。Resume 复用原子提交的按任务结果。
- Sealed Final 在进化期间不可用，只能在全局最佳 Candidate 锁定后打开一次。

## 文档入口

| 你想了解什么         | 入口                                                    |
| -------------------- | ------------------------------------------------------- |
| 信任边界和数据流     | [架构](docs/architecture.zh.md)                         |
| Mode、Branch 和预算  | [Controller modes](docs/controller-modes.md)            |
| Region 搜索          | [Search strategy](docs/search-strategy.md)              |
| OfficeVal 任务与评测 | [OmegaUse Cowork 运行手册](docs/cowork-mvp.zh.md)      |
| 扩展或审查平台       | [贡献指南](CONTRIBUTING.md)                             |
| 开发进度与验证边界   | [开发日志](README.dev.zh.md)                            |

## 许可证

Controller 与本仓库新增代码使用 MIT License。`sources/deepseek-harness/` 是固定版本的上游子模块，遵循其自身许可证和版权声明。
