<p align="center">
  <img src="docs/assets/harness-evo-gym-hero-v2.png" width="100%" alt="HarnessEvoGym：多个 Agent Harness 在受控环境中围绕 Controller 进行可审计进化。" />
</p>

<h1 align="center">HarnessEvoGym</h1>

<p align="center">
  <strong>让 Agent Harness 自己进化，但始终在可复现、可审计的边界内。</strong>
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
  <img alt="549 tests" src="https://img.shields.io/badge/tests-549%20Node%20%2B%2014%20Python-20a36a?style=flat-square" />
</p>

> **一句话定位**：HarnessEvoGym 是一个面向 Agent Harness 的 RSI（Recursive Self-Improvement）训练场。它让 Updater 修改 Candidate，让 Solver 在真实任务环境中验证修改，再由 Controller 决定保留、回退、暂停或恢复。

<table>
  <tr>
    <td width="33%"><strong>研究问题</strong><br />如何让 Harness 持续变好，而不是只让 Prompt 变长？</td>
    <td width="33%"><strong>当前环境</strong><br />OmegaUse-OfficeVal 与 HLE Text-only Math</td>
    <td width="33%"><strong>核心原则</strong><br />评测器、隐藏集、凭据和晋升规则不属于 Candidate</td>
  </tr>
</table>

## 它解决什么问题

让一个 Coding Agent 修改自己的代码并不难；难的是判断修改是否真的有效，并且保证它不能修改裁判、偷看隐藏题、污染数据集或把一次网络故障伪装成能力提升。

HarnessEvoGym 把这些边界做成 Controller 可以执行的协议：

| 关注点 | Controller 的做法 |
| --- | --- |
| 修改什么 | Target 声明 Mutation Region，Controller 为每一轮发放一次性 Mutation Lease |
| 谁来修改 | Codex CLI、Claude Code、DeepSeek Harness 等完整 Coding Agent Session |
| 在哪里验证 | Environment 独立物化任务、工作区和 Verifier |
| 如何搜索 | Population Mode 与 SearchStrategy 解耦，可复用、可替换 |
| 如何决定 | 只用受信 validation 结果做晋升；失败的基础设施进入暂停和 Resume |

## 进化闭环

<p align="center">
  <img src="docs/assets/harness-evo-gym-loop-v2.png" width="100%" alt="HarnessEvoGym 的 Candidate、Environment、Solver、Verifier 和 Updater 闭环。" />
</p>

一轮进化的实际链路是：

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

Updater 保留完整的分析、假设、自检和编码过程；Controller 不把它拆成固定的微操作，只负责把“能改什么、在哪里改、如何评测”锁死。

## 当前稳定支持

<table>
  <tr>
    <th width="22%">环境</th>
    <th width="38%">它验证什么</th>
    <th width="40%">仓库入口</th>
  </tr>
  <tr>
    <td><strong>OfficeVal</strong></td>
    <td>Agent 是否能在隔离 Office 工作区里完成文档、表格、演示和脚本任务，并生成可评分交付物。</td>
    <td><code>controller/src/environments/omegause-officeval.mjs</code><br /><a href="docs/cowork-mvp.zh.md">Office 运行手册</a></td>
  </tr>
  <tr>
    <td><strong>HLE Text-only Math</strong></td>
    <td>Agent 是否能在固定 revision、分层抽样和 sealed test 规则下完成文本数学推理。</td>
    <td><code>controller/src/hle-partition-runner.mjs</code><br /><a href="benchmarks/hle-text-math/README.zh.md">HLE 运行手册</a></td>
  </tr>
</table>

OfficeVal 与 HLE 共享 Candidate、Updater、反馈、晋升、回滚、Checkpoint 和审计原则，但使用各自独立的任务物化与沙箱执行链路。

### OfficeVal

- Solver 在隔离镜像和临时工作区内操作原始输入。
- Verifier 在独立、只读、无网络容器中评分。
- 原始数据集不会直接作为可写目录挂载。
- 已提交的题目结果可以在 Resume 时复用，合法的零分也不会被误当成未完成。

### HLE

- 当前只承诺 `cais/hle` 的 text-only Math 子集，不等同于完整 HLE 成绩。
- validation 可以进入反馈和晋升；test 题目、答案和 Judge 过程留在 sealed vault。
- HLE Runtime JSON 使用相对路径，默认运行数据位于仓库旁边的 `../.rsi/`。
- 数据需要 Hugging Face 访问条件、运行时凭据和本机工具链，不把数据或 Key 提交到 Git。

## 五种 Population Mode

| Mode | 搜索行为 |
| --- | --- |
| `single` | 一个 Branch 消耗完整 Candidate budget |
| `independent` | 多个 Branch 独立搜索，不共享历史 |
| `mutualism` | 独立搜索，同时读取只读的 peer evolution evidence |
| `competition` | Branch 竞争额外的 Candidate budget pool |
| `combined` | 同时启用 peer sharing 与 budget competition |

Population Mode 与 Module Search 正交。例如，`combined + linear-hill-climb` 和 `combined + progressive-risk-expansion` 是两种不同的有效组合。

## 快速开始

### 1. 安装并做离线检查

需要 Linux、Docker、Node.js 20+、npm 和 Git。

```bash
git clone https://github.com/autocosm-ai/HarnessEvoGym.git
cd HarnessEvoGym
npm ci
npm run check
npm test
npm run test:eval
```

### 2. 只校验配置，不调用模型

```bash
npm run rsi -- experiment validate \
  --config experiments/reasoning-msa-progressive-strict-smoke.json
```

### 3. 准备运行时凭据

```bash
export RSI_PROVIDER_BASE_URL=https://provider.example/v1
read -rsp 'Provider API Key: ' RSI_PROVIDER_API_KEY
export RSI_PROVIDER_API_KEY
```

真实运行前还要按环境准备数据集和 Runtime：

- OfficeVal：阅读 [`docs/cowork-mvp.zh.md`](docs/cowork-mvp.zh.md)。
- HLE：阅读 [`benchmarks/hle-text-math/README.zh.md`](benchmarks/hle-text-math/README.zh.md)。

任何密钥只通过运行时 FD 注入，不写入 Experiment、Adapter、Candidate、Trace 或 Git。Codex/Claude Code 的宿主 CLI 安装目录也通过 `RSI_*` 环境变量注入，不绑定某一台机器的 `/home/...` 路径。

## 代码地图

```text
controller/                  信任根：调度、权限、晋升、回滚、Resume
controller/src/environments  OfficeVal 与 HLE 的环境执行器
adapters/                    Target、Environment、Updater、Provider、Strategy 配置
benchmarks/                  数据划分、任务清单和运行手册
experiments/                 可复现实验配方
scripts/                     Runtime 准备、Smoke 和正式运行入口
eval/                        独立 OfficeVal 泛化评测兼容工具
README.dev.zh.md             开发日志与工程状态
```

## 如何扩展

- **新 Harness**：实现 Target Adapter，声明 Source、CandidateSeed、Validator 和 Mutation Catalog。
- **新任务领域**：实现 Environment Adapter，提供任务物化、隔离工作区、Verifier、指标和数据划分。
- **新搜索策略**：实现 SearchStrategy，只返回受信 Catalog 中的 Region ID 和父 Candidate。
- **新进化算法**：注册兼容 Population State、Branch、Budget、Checkpoint 和 Resume 契约的 EvolutionAlgorithm。
- **新 Updater**：实现 Updater Adapter，保留完整 Coding Agent Session，由 Controller 管理可写权限。

完整接口、协议边界、测试矩阵和 PR 要求见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

## 当前边界

- Office 的 Linux 链路不覆盖依赖 Windows COM 的题目。
- HLE 当前只覆盖 text-only Math 子集；运行前必须准备受门控的数据与工具链。
- Sealed test 不能参与进化决策，只能在正式 Final/关闭流程中处理。
- Harbor、SWE-bench、PutnamBench 和 Synthetic Text Reasoning 保留为实验性或兼容路径，暂不属于稳定支持承诺。
- 项目仍是研究预览版；正式比较应预注册 Seed、Trial、资源预算和统计汇总。

## 文档入口

| 你想了解什么 | 入口 |
| --- | --- |
| 信任边界和数据流 | [`docs/architecture.zh.md`](docs/architecture.zh.md) |
| Mode、Branch 和预算 | [`docs/controller-modes.md`](docs/controller-modes.md) |
| OfficeVal 任务与评测 | [`docs/cowork-mvp.zh.md`](docs/cowork-mvp.zh.md) |
| HLE 数据、split 和 sealed broker | [`benchmarks/hle-text-math/README.zh.md`](benchmarks/hle-text-math/README.zh.md) |
| 开发进度和已知边界 | [`README.dev.zh.md`](README.dev.zh.md) |

## 许可证

Controller 与本仓库新增代码使用 MIT License。`sources/deepseek-harness/` 是固定版本的上游子模块，遵循其自身许可证和版权声明。
