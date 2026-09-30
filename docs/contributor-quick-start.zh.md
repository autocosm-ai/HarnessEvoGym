# 贡献者快速入门

本文档帮助新开发者快速理解 HarnessEvoGym RSI 项目架构，并开始贡献代码。

## 核心概念速览

HarnessEvoGym 是一个 **自我改进型 AI 系统的进化实验平台**。它让 AI Harness（工具集成框架）通过自动化迭代不断优化自己解决特定任务的能力。

**一句话总结**：Controller 调度 Solver 做题 → 收集失败案例 → Updater 改进代码 → 验证是否变好 → 循环迭代。

### 三角模型：Controller - Solver - Updater

```
┌─────────────┐
│ Controller  │  ← 信任根：调度、评测、晋升决策
│   (冻结)    │
└──────┬──────┘
       │
       ├─────────────────┐
       │                 │
  ┌────▼─────┐      ┌───▼──────┐
  │  Solver  │      │ Updater  │
  │ (被优化) │      │ (改进器) │
  └──────────┘      └──────────┘
       │                 │
       │ 做题            │ 修改代码
       ▼                 ▼
  Environment       Candidate
```

- **Controller**: 信任根，负责调度、评测、晋升决策，代码冻结不可被 Candidate 修改
- **Solver**: 使用 Candidate Harness 在 Environment 中解题的执行单元
- **Updater**: 分析失败案例并修改 Candidate 代码的 AI Agent

### 关键术语

| 术语 | 解释 |
|------|------|
| **H0** | 初始版本，所有进化实验的公共起点 |
| **Candidate** | 一个完整的 Harness 实例（包含 Prompt、Skill、Agent 代码） |
| **Champion** | 当前最优版本，下一轮进化的父版本 |
| **Generation** | 进化代数，每次 Mutation + Evaluation 为一代 |
| **Partition** | 数据集划分：feedback（训练）、selection（验证）、final（测试） |
| **Trial** | 单次题目执行（可能有多个 seed） |
| **Verifier** | 独立评分程序，Solver 看不到 |
| **MutationLease** | 单轮写权限，限制 Updater 只能修改特定文件 |

## 架构分层

```
experiments/           ← 最终可执行配置（Target × Environment × Recipe）
    ├── adapters/      ← 各组件的声明式配置
    ├── benchmarks/    ← 题目集合与 Split
    ├── evaluation/    ← 评测指标与晋升策略
    └── recipes/       ← Population 算法与搜索策略
         
controller/           ← 核心调度与协议实现（信任根）
    ├── src/
    │   ├── cowork-orchestrator.mjs    ← Evolution 主循环
    │   ├── environments/              ← Environment Adapter 实现
    │   ├── runtimes/                  ← Solver/Updater Driver
    │   ├── strategies/                ← SearchStrategy 实现
    │   └── protocol.mjs               ← 协议验证与数据结构
    └── test/                          ← 单元测试与集成测试

environments/         ← Environment 配置与只读资源
sources/              ← 被优化的 Harness 源码
targets/              ← Target 的 CandidateSeed（H0）
docker/               ← 隔离运行时镜像
```

## 快速开始

### 1. 环境准备

```bash
# 克隆仓库
git clone <repo-url>
cd HarnessEvoGym

# 安装依赖
npm install

# 运行测试（不依赖外部服务）
npm test

# 代码检查
npm run check
```

### 2. 运行第一个测试

```bash
# 运行 Text Reasoning 单元测试
node --test controller/test/text-reasoning-smoke.test.mjs

# 运行 Harbor 端到端测试
node --test controller/test/harbor-e2e-smoke.test.mjs
```

### 3. 理解一次完整进化流程

以 **Single Branch** 为例：

```
1. 物化 H0
   └─> Materializer 生成初始 Candidate

2. Baseline 评测
   └─> 在 feedback partition 运行 H0，记录初始表现

3. 第一代进化
   ├─> SearchStrategy 选择要修改的 Region（如 skill-guidance）
   ├─> Controller 发放 MutationLease（限制写权限）
   ├─> Updater 读取 feedback 失败案例，修改代码
   ├─> Controller 验证 Diff 合法性
   ├─> Solver 在 feedback partition 运行新版本
   └─> Evaluation Policy 判断是否晋升为新 Champion

4. 第二代进化（如果第一代晋升成功）
   └─> 从新 Champion 继续迭代

5. Final Evaluation（所有代数完成后）
   └─> 在 sealed final partition 运行最终版本
```

## 如何贡献

### 新增 Environment

如果你想接入新的评测环境（如新的编程题库、文档处理任务等）：

1. **定义协议**：
   - 任务输入格式
   - 交付物格式
   - 评分规则

2. **实现 Environment Adapter**：
   ```javascript
   class MyEnvironment {
     async preflight() { /* 验证数据集 */ }
     async runCandidatePartition({ candidateId, partition, ... }) {
       // 1. 准备工作区
       // 2. 调用 Solver Driver
       // 3. 运行 Verifier
       // 4. 返回 Result
     }
   }
   ```

3. **配置文件**：
   ```yaml
   # environments/my-environment.yml
   apiVersion: harness-rsi/v1alpha1
   kind: EnvironmentAdapter
   spec:
     protocol: my-protocol-v1
     source:
       datasetRoot: /path/to/dataset
     runtime:
       image: harness-rsi/my-env:v1
     verifier:
       timeoutSeconds: 300
   ```

4. **测试**：
   - 单元测试：验证 Workspace、Verifier、Resume
   - 端到端测试：至少运行 3 道真实题目

参考示例：
- `controller/src/environments/omegause-officeval.mjs`
- `controller/test/omegause-offline-e2e.test.mjs`

### 新增 SearchStrategy

如果你想实现新的搜索算法（决定每轮修改哪些模块）：

1. **实现 Strategy 接口**：
   ```javascript
   export function myStrategy({ context, state, catalog, riskCeiling }) {
     // context: 父 Candidate、历史收益等脱敏信息
     // state: 上一轮的 Strategy State
     // catalog: Target 允许修改的 Region 列表
     // riskCeiling: 风险上限（L1/L2/L3）
     
     return {
       parentCandidateId: 'g001',
       regionIds: ['skill-guidance'],  // 本轮开放的 Region
       state: { /* 可序列化的状态 */ },
       exhausted: false
     }
   }
   ```

2. **配置 Adapter**：
   ```yaml
   # adapters/strategies/my-strategy.yml
   apiVersion: harness-rsi/v1alpha1
   kind: SearchStrategyAdapter
   metadata:
     id: my-strategy
   spec:
     protocol: builtin-v1
     implementation: my-strategy
   ```

3. **测试**：
   - Context 脱敏（不能泄漏凭据、Final 题目）
   - Region 白名单（只返回 Catalog 中存在的 Region）
   - State 可序列化

参考示例：
- `controller/src/strategies/linear-hill-climb.mjs`
- `controller/src/strategies/progressive-risk-expansion.mjs`

### 修改 Population 算法

**注意**：修改 Population 是高风险变更，必须同时回归五种 Mode 和多个 Environment。

只有当 Branch 之间的**拓扑关系**真正变化时才修改 `controller/src/population-orchestrator.mjs`。

PopulationOrchestrator 只消费：
- `BranchProjection`
- `BranchStepResult`
- `EvaluationSummary`
- Budget 与 Peer Evidence

它**不能**依赖：
- 特定 Harness 的目录结构
- 特定 Environment 的字段（如 `validationVerified`）
- 特定任务类型（Office、Reasoning、Harbor）

### 添加测试

测试分类：

```
controller/test/
├── *.test.mjs              ← 单元测试（快速，无外部依赖）
├── *-integration.test.mjs  ← 集成测试（需要 Docker）
└── *-e2e.test.mjs          ← 端到端测试（完整流程）
```

**测试命名规范**：

```javascript
// 单元测试
test('OmegaUse Source Manifest 摘要校验', async () => { ... })

// 需要外部资源的测试：条件跳过
const skipTest = !process.env.RSI_DATASET_ROOT
test('OmegaUse 离线验证', { skip: skipTest }, async () => { ... })
```

**验证层次**：

| 变更类型 | 最低验证 |
|---------|---------|
| 协议变更 | 单元测试 + Producer/Consumer 兼容性 |
| Environment | Workspace、Verifier、Resume、E2E |
| Updater | Lease、报告、Stop 协议、隔离 |
| SearchStrategy | Context 脱敏、Region 白名单、State JSON |
| Population | 五 Mode、Budget、Promotion、Final |

## 安全边界

以下内容**不能**被 Candidate、Updater 或 SearchStrategy 修改：

- ❌ Verifier 代码与 Rubric
- ❌ Benchmark Split、Gold、Sealed Final
- ❌ Controller 与 Promotion Policy
- ❌ Sandbox、资源上限、Credential
- ❌ Target 的 Catalog 与 Validator
- ❌ Experiment 冻结的模型、Budget、Seed

必须维护的隔离：

| 角色 | 可见范围 | 不可见范围 |
|------|---------|-----------|
| Solver | Candidate（只读）、Task Workspace（可写） | Gold、Verifier、API Key |
| Updater | Candidate（可写）、Feedback（只读） | Final 题目、真实 API Key |
| Verifier | Submission（只读）、Evaluator（只读） | 模型 Key、网络 |
| SearchStrategy | 脱敏 Context | 凭据、Final、完整路径 |

## 常见问题

### Q: 测试失败：`docker cp --chown` 不支持

**A**: 这是已知问题，P0-6 已修复。确保使用最新的 `controller/src/docker.mjs`，它使用 `-a` + 单独 `chown`。

### Q: OmegaUse 测试跳过

**A**: 需要设置环境变量：

```bash
export RSI_OFFICEVAL_DATASET_ROOT=/path/to/OmegaUse-OfficeVal-Dataset
export RSI_OFFICEVAL_EVALUATOR_ROOT=/path/to/OmegaUse-OfficeVal
node --test controller/test/omegause-offline-e2e.test.mjs
```

### Q: 如何调试 Solver/Updater 运行时错误？

**A**: 查看日志目录：

```bash
# Solver 日志
cat .rsi/runs/<run-id>/trials/<execution-id>/<candidate-id>/<partition>/<instance-id>/solver.log

# Updater 日志
cat .rsi/runs/<run-id>/generations/<generation>/updater.log
```

### Q: 如何验证 Checkpoint 机制？

**A**: 运行中断后 Resume：

```bash
# 第一次运行（中途 Ctrl+C）
npm run rsi -- experiment run --config experiments/example.json

# 第二次运行（自动 Resume）
npm run rsi -- experiment run --config experiments/example.json
```

Controller 会复用已原子提交的逐题结果。

## 代码风格

- **单一职责**：每个函数只做一件事
- **不变性**：优先使用 `const`，避免修改传入对象
- **错误处理**：基础设施错误向上抛出，不伪装成合法 0 分
- **注释**：复杂逻辑写清楚"为什么"，不只是"做什么"

**命名约定**：

```javascript
// 函数：驼峰，动词开头
async function runCandidatePartition() { ... }

// 常量：全大写下划线
const MAXIMUM_RETRIES = 3

// 类：大驼峰
class OmegaUseOfficeValEnvironment { ... }

// 文件：小写连字符
omegause-officeval.mjs
```

## PR 流程

1. **创建分支**：从 `main` 创建清晰命名的分支
   ```bash
   git checkout -b feat/add-xxx-environment
   ```

2. **开发 + 测试**：
   ```bash
   npm run check  # 代码检查
   npm test       # 运行测试
   git diff --check  # 检查空白字符
   ```

3. **提交**：
   ```bash
   git add .
   git commit -m "feat: add XXX Environment"
   ```

4. **PR 描述**必须包含：
   - 改了什么、为什么
   - 信任边界影响
   - 验证证据（测试通过截图/日志）
   - 未验证风险

5. **Review Checklist**：
   - [ ] 变更归属明确（Target/Environment/Strategy/Controller）
   - [ ] 没有场景私有逻辑混入通用 Population
   - [ ] 新配置固定了 Source、Seed、模型、Budget、Split 身份
   - [ ] Updater 写权限能被 MutationLease 硬校验
   - [ ] 隔离边界正确（Solver/Updater/Verifier 看不到不该看的）
   - [ ] 基础设施错误不会被记成合法 0 分
   - [ ] 相关测试通过

## 进阶阅读

- [总体架构](architecture.zh.md) - 深入理解系统设计
- [Population 五种 Mode](controller-modes.zh.md) - Branch 拓扑与竞争策略
- [搜索空间与 SearchStrategy](search-strategy.zh.md) - 模块搜索原理
- [OmegaUse Cowork Runbook](cowork-mvp.zh.md) - 真实场景案例
- [CONTRIBUTING.md](../CONTRIBUTING.md) - 完整贡献指南

## 获得帮助

- 查看 [已知问题](../P0-P1-TASKS.md)
- 阅读 [测试用例](../controller/test/) 作为示例
- 提交 Issue 描述问题
