# Algorithm SDK v2 文档

HarnessEvoGym RSI Algorithm SDK 提供完整的进化算法扩展能力，支持自定义 Selection Strategy、Mutation Policy 和完整的进化算法实现。

本文档面向第三方开发者，提供接口规范、实现指南和测试方法。

──────────────────────────────────────────

## 目录

- [核心概念](#核心概念)
- [Search Strategy 接口](#search-strategy-接口)
- [Mutation Catalog 接口](#mutation-catalog-接口)
- [自定义 Strategy 实现](#自定义-strategy-实现)
- [测试指南](#测试指南)
- [最佳实践](#最佳实践)
- [常见问题](#常见问题)

──────────────────────────────────────────

## 核心概念

### RSI 进化循环

```
┌─────────────┐
│  Champion   │ (当前最优 Candidate)
└──────┬──────┘
       │
       ▼
┌─────────────────────────────┐
│  Search Strategy.propose()  │ 选择父 Candidate 和 Mutation Plan
└──────────┬──────────────────┘
           │
           ▼
    ┌──────────────┐
    │   Updater    │ 应用 Mutation，生成新 Candidate
    └──────┬───────┘
           │
           ▼
    ┌──────────────┐
    │  Evaluation  │ 在 Benchmark 上评测新旧 Candidate
    └──────┬───────┘
           │
           ▼
    ┌──────────────────────────┐
    │  Selection Decision      │ 根据 Policy 决定是否晋升
    └──────┬───────────────────┘
           │
           ▼
┌──────────────────────────────────┐
│  Search Strategy.observe()       │ 观察结果，更新内部状态
└──────────┬───────────────────────┘
           │
           ▼
      (循环继续)
```

### 三层抽象

**1. Search Strategy（搜索策略）**
- **职责**：决定每一代选择哪个父 Candidate、应用哪些 Mutation Regions
- **输入**：当前 Champion、候选父节点、搜索历史、Mutation Catalog
- **输出**：Mutation Plan（parentId + regionIds）
- **状态**：可维护内部状态（例如：当前风险层级、连续失败次数）

**2. Mutation Catalog（突变目录）**
- **职责**：定义 Target 的可变异区域和风险层级
- **内容**：Regions（id、description、riskLevel、dependencies、conflicts）
- **约束**：每个 Region 有明确的 writable paths、semantic constraints

**3. Selection Policy（选择策略）**
- **职责**：根据评测结果决定新 Candidate 是否晋升为 Champion
- **输入**：Baseline 和 Candidate 的 Benchmark 结果
- **输出**：eligible (true/false) + gates (每个 gate 的通过情况)

──────────────────────────────────────────

## Search Strategy 接口

### 接口规范

Search Strategy 必须实现两个方法：`propose()` 和 `observe()`

```javascript
/**
 * Search Strategy 接口
 */
interface SearchStrategy {
  id: string  // Strategy 唯一标识符
  
  /**
   * propose: 提出下一代的 Mutation Plan
   * 
   * @param context - 搜索上下文
   * @param state - Strategy 内部状态（上一轮 observe 返回的 state）
   * @returns { plan, state } - Mutation Plan 和更新后的状态
   */
  propose(context: ProposeContext, state: StrategyState | null): {
    plan: MutationPlan,
    state: StrategyState
  }
  
  /**
   * observe: 观察本轮结果，更新内部状态
   * 
   * @param outcome - 本轮执行结果
   * @param state - Strategy 内部状态
   * @returns { state, exhausted } - 更新后的状态和是否已耗尽搜索空间
   */
  observe(outcome: ObserveOutcome, state: StrategyState): {
    state: StrategyState,
    exhausted: boolean  // true 表示搜索空间已耗尽，Evolution 应停止
  }
}
```

### ProposeContext

```javascript
{
  runId: string,              // Evolution Run ID
  generation: number,         // 当前代数（1-based）
  riskCeiling: string,        // 风险上限（'l1' | 'l2' | 'l3'）
  
  catalog: MutationCatalog,   // Mutation 目录
  
  championId: string,         // 当前 Champion ID
  allowedParentIds: string[], // 允许作为父节点的 Candidate IDs
  
  candidates: Array<{         // 所有已生成的 Candidates
    id: string,
    parentId: string,
    digest: string,           // 内容摘要
    status: 'promoted' | 'rejected',
  }>,
  
  searchHistory: Array<{      // 搜索历史（最近的条目）
    generation: number,
    parentId: string,
    proposalId: string,
    status: 'promoted' | 'rejected' | 'invalid-proposal',
    mutationPlanId: string,
    regionIds: string[],
    championBeforeId: string,
    championAfterId: string,
    selection?: {             // 如果 status === 'promoted' 或 'rejected'
      eligible: boolean,
      gates: Array<{
        id: string,
        passed: boolean,
        actual: number,
        operator: string,
        expected: number,
      }>,
    },
    rejection?: {             // 如果 status === 'invalid-proposal'
      stage: string,
    },
  }>,
}
```

### MutationPlan

```javascript
{
  apiVersion: 'harness-rsi/v1alpha1',
  kind: 'MutationPlan',
  
  metadata: {
    id: string,               // Plan 唯一 ID（自动生成或手动指定）
    strategy: string,         // Strategy ID
    generation: number,
  },
  
  spec: {
    parentIds: [string],      // 父 Candidate ID（当前只支持单父）
    regionIds: string[],      // 要应用的 Mutation Region IDs
  },
}
```

### ObserveOutcome

```javascript
{
  runId: string,
  generation: number,
  
  parentId: string,           // 本轮父 Candidate ID
  proposalId: string,         // 本轮生成的 Candidate ID
  
  status: 'promoted' | 'rejected' | 'invalid-proposal',
  
  championId: string,         // 本轮结束后的 Champion ID
  
  regionIds: string[],        // 本轮应用的 Region IDs
  
  selection?: {               // 如果 status !== 'invalid-proposal'
    eligible: boolean,
    gates: [...],
  },
  
  rejection?: {               // 如果 status === 'invalid-proposal'
    stage: string,            // 'update-and-diff' | 'feedback-gates' | 'acceptance-gates'
  },
}
```

### StrategyState

Strategy 的内部状态，必须满足：

- 可 JSON 序列化
- 大小 <= 64 KiB
- 不包含敏感信息（apiKey、secret、token、credential 等关键词）
- 是普通 JSON 对象（不能有循环引用、特殊 prototype）

示例：

```javascript
{
  activeRiskLevel: 'l2',
  consecutiveMisses: 2,
  roundsProposed: 15,
  roundsObserved: 15,
  expansions: 1,
  exhausted: false,
  // ... 其他自定义字段
}
```

──────────────────────────────────────────

## Mutation Catalog 接口

Mutation Catalog 定义 Target 的可变异区域。

### MutationCatalog 结构

```yaml
apiVersion: harness-rsi/v1alpha1
kind: MutationCatalog

metadata:
  target: example-target  # Target ID

spec:
  riskLevels:             # 支持的风险层级
    - l1
    - l2
    - l3
  
  maximumRegionsPerPlan: 3  # 每个 Mutation Plan 最多包含几个 Regions
  
  regions:
    - id: prompt-system-message
      description: "修改 system message 以改进推理引导"
      riskLevel: l1       # 风险层级
      requires: []        # 依赖的其他 Regions（必须同时选中）
      conflicts: []       # 冲突的 Regions（不能同时选中）
    
    - id: tool-function-refine
      description: "优化工具函数实现"
      riskLevel: l2
      requires: []
      conflicts: []
    
    - id: core-algorithm-rewrite
      description: "重写核心算法逻辑"
      riskLevel: l3
      requires: []
      conflicts: [prompt-system-message]  # 不能同时修改 prompt 和算法
```

### Region 依赖与冲突

**requires**：Region A requires Region B 表示"如果选中 A，必须同时选中 B"

示例：
```yaml
- id: advanced-caching
  requires: [basic-caching]  # 高级缓存依赖基础缓存
```

**conflicts**：Region A conflicts with Region B 表示"A 和 B 不能同时选中"

示例：
```yaml
- id: greedy-search
  conflicts: [beam-search, random-search]  # 搜索策略互斥
```

──────────────────────────────────────────

## 自定义 Strategy 实现

### 方式一：Builtin Strategy（JavaScript 实现）

适合复杂逻辑、需要高性能的 Strategy。

**步骤 1**：实现 Strategy

```javascript
// controller/src/strategies/my-custom-strategy.mjs

import { ProtocolError } from '../protocol.mjs'
import { MUTATION_RISK_LEVELS } from '../mutation-catalog.mjs'

export function createMyCustomStrategy(configuration) {
  // 验证配置
  const config = {
    startRiskLevel: configuration.startRiskLevel ?? 'l1',
    maxRetries: configuration.maxRetries ?? 5,
  }
  
  if (!MUTATION_RISK_LEVELS.includes(config.startRiskLevel)) {
    throw new ProtocolError('startRiskLevel must be l1, l2, or l3')
  }
  
  return {
    id: 'my-custom-strategy',
    
    propose(context, previousState) {
      // 初始化或读取状态
      const state = previousState ?? {
        currentRiskLevel: config.startRiskLevel,
        attemptedRegions: new Set(),
        retries: 0,
      }
      
      // 选择父 Candidate
      const parentId = context.championId
      
      // 选择 Regions（示例：随机选择未尝试过的 Region）
      const availableRegions = context.catalog.spec.regions
        .filter(r => r.riskLevel === state.currentRiskLevel)
        .filter(r => !state.attemptedRegions.has(r.id))
      
      if (availableRegions.length === 0) {
        throw new ProtocolError('No available regions at current risk level')
      }
      
      const selectedRegion = availableRegions[Math.floor(Math.random() * availableRegions.length)]
      
      // 更新状态
      state.attemptedRegions.add(selectedRegion.id)
      
      // 生成 Mutation Plan
      const plan = {
        apiVersion: 'harness-rsi/v1alpha1',
        kind: 'MutationPlan',
        metadata: {
          id: `gen${context.generation}-${selectedRegion.id}`,
          strategy: this.id,
          generation: context.generation,
        },
        spec: {
          parentIds: [parentId],
          regionIds: [selectedRegion.id],
        },
      }
      
      return { plan, state }
    },
    
    observe(outcome, previousState) {
      const state = { ...previousState }
      
      if (outcome.status === 'promoted') {
        // 晋升成功，重置重试计数
        state.retries = 0
      } else {
        // 失败，增加重试计数
        state.retries += 1
      }
      
      // 检查是否耗尽
      const exhausted = state.retries >= config.maxRetries
      
      return { state, exhausted }
    },
  }
}
```

**步骤 2**：注册 Strategy

```javascript
// controller/src/search-strategy.mjs

import { createMyCustomStrategy } from './strategies/my-custom-strategy.mjs'

// 在文件顶部添加注册
registerBuiltinSearchStrategy('my-custom-strategy', createMyCustomStrategy)
```

**步骤 3**：创建 Adapter

```yaml
# adapters/strategies/my-custom-strategy.yml

apiVersion: harness-rsi/v1alpha1
kind: SearchStrategyAdapter

metadata:
  id: my-custom-strategy
  name: My Custom Strategy

spec:
  protocol: builtin-v1
  implementation: my-custom-strategy
  configuration:
    startRiskLevel: l1
    maxRetries: 5
```

**步骤 4**：在实验配置中使用

```json
{
  "experiment": {
    "bundle": {
      "strategy": "adapters/strategies/my-custom-strategy.yml"
    }
  }
}
```

### 方式二：Docker Strategy（任意语言实现）

适合使用 Python、Rust 等其他语言实现的 Strategy。

Docker Strategy 通过 stdin/stdout 与 Controller 通信，使用 JSON Lines 协议。

**协议示例**：

```
Controller -> Strategy (stdin):
{"operation": "propose", "context": {...}, "state": {...}}

Strategy -> Controller (stdout):
{"plan": {...}, "state": {...}}

Controller -> Strategy (stdin):
{"operation": "observe", "outcome": {...}, "state": {...}}

Strategy -> Controller (stdout):
{"state": {...}, "exhausted": false}
```

详细实现参考 `adapters/strategies/docker-round-robin.example.yml`。

──────────────────────────────────────────

## 测试指南

### 单元测试

为 Strategy 编写单元测试，验证 propose 和 observe 逻辑。

```javascript
// controller/test/my-custom-strategy.test.mjs

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createMyCustomStrategy } from '../src/strategies/my-custom-strategy.mjs'

describe('My Custom Strategy', () => {
  it('初始 propose 选择正确的 Region', () => {
    const strategy = createMyCustomStrategy({ startRiskLevel: 'l1' })
    
    const context = {
      runId: 'test-run',
      generation: 1,
      riskCeiling: 'l3',
      catalog: {
        spec: {
          regions: [
            { id: 'region-l1-a', riskLevel: 'l1' },
            { id: 'region-l1-b', riskLevel: 'l1' },
          ],
        },
      },
      championId: 'baseline',
      allowedParentIds: ['baseline'],
      candidates: [],
      searchHistory: [],
    }
    
    const result = strategy.propose(context, null)
    
    assert.ok(result.plan)
    assert.equal(result.plan.spec.parentIds[0], 'baseline')
    assert.ok(['region-l1-a', 'region-l1-b'].includes(result.plan.spec.regionIds[0]))
  })
  
  it('observe 在晋升后重置重试计数', () => {
    const strategy = createMyCustomStrategy({ maxRetries: 3 })
    
    const outcome = {
      runId: 'test-run',
      generation: 1,
      parentId: 'baseline',
      proposalId: 'g001-l1',
      status: 'promoted',
      championId: 'g001-l1',
      regionIds: ['region-l1-a'],
    }
    
    const previousState = { retries: 2 }
    const result = strategy.observe(outcome, previousState)
    
    assert.equal(result.state.retries, 0)
    assert.equal(result.exhausted, false)
  })
  
  it('observe 在连续失败后标记 exhausted', () => {
    const strategy = createMyCustomStrategy({ maxRetries: 3 })
    
    let state = { retries: 0 }
    
    for (let i = 0; i < 3; i += 1) {
      const outcome = {
        status: 'rejected',
        championId: 'baseline',
      }
      const result = strategy.observe(outcome, state)
      state = result.state
      
      if (i < 2) {
        assert.equal(result.exhausted, false)
      } else {
        assert.equal(result.exhausted, true)
      }
    }
  })
})
```

### 集成测试

创建小规模实验配置，验证 Strategy 在真实 Evolution 中的表现。

```json
{
  "apiVersion": "harness-rsi/v1alpha1",
  "kind": "Experiment",
  "metadata": {
    "id": "test-my-custom-strategy"
  },
  "spec": {
    "bundle": {
      "target": "targets/text-reasoning/target.yml",
      "updater": "adapters/updaters/deepseek-harness.yml",
      "environment": "environments/text-reasoning-smoke.yml",
      "provider": "adapters/providers/zcloud-openai.yml",
      "strategy": "adapters/strategies/my-custom-strategy.yml"
    },
    "benchmark": "benchmarks/text-reasoning-smoke/benchmark.json",
    "policy": "evaluation/policies/strict-mean-reward-improvement.json",
    "models": {
      "solver": { "provider": "zcloud-openai", "model": "gpt-5.6-terra", "maxTokens": 4096 },
      "updater": { "provider": "zcloud-openai", "model": "gpt-5.6-terra", "maxTokens": 4096 }
    },
    "evolution": {
      "mutationLevel": "l1",
      "generations": 5,
      "trialsPerInstance": 1,
      "seeds": [20250129]
    }
  }
}
```

运行测试：

```bash
node controller/src/cli.mjs run experiments/test-my-custom-strategy.json
```

验证：

- ✅ Strategy 成功完成所有 generations
- ✅ 每一代都产生有效的 Mutation Plan
- ✅ observe 正确更新状态
- ✅ exhausted 机制正常工作

──────────────────────────────────────────

## 最佳实践

### 1. 状态管理

**DO**：
- 保持状态简洁，只存储必要信息
- 使用 JSON 可序列化的数据结构
- 明确初始化状态（`previousState ?? defaultState`）

**DON'T**：
- 不要在状态中存储大对象（如完整的 candidates 列表）
- 不要存储敏感信息（API keys、secrets）
- 不要使用循环引用

### 2. Region 选择

**DO**：
- 考虑 Region 的 requires 和 conflicts 约束
- 尊重 `maximumRegionsPerPlan` 限制
- 优先选择未尝试过的 Regions

**DON'T**：
- 不要选择超出 `riskCeiling` 的 Regions
- 不要违反 requires/conflicts 约束
- 不要重复选择已失败的 Region 组合

### 3. 父节点选择

**DO**：
- 从 `allowedParentIds` 中选择
- 优先选择 Champion 或近期晋升的 Candidates
- 考虑父节点的历史表现

**DON'T**：
- 不要选择不在 `allowedParentIds` 中的节点
- 不要盲目选择 Champion（可能陷入局部最优）

### 4. Exhaustion 判断

**DO**：
- 在搜索空间确实耗尽时返回 `exhausted: true`
- 设置合理的失败上限
- 记录 exhaustion 原因

**DON'T**：
- 不要过早 exhaust（给 Evolution 更多探索机会）
- 不要永不 exhaust（避免无效循环）

### 5. 错误处理

**DO**：
- 抛出 `ProtocolError` 并附带详细信息
- 验证输入数据的合法性
- 提供清晰的错误消息

**DON'T**：
- 不要静默失败
- 不要返回无效的 Mutation Plan

──────────────────────────────────────────

## 常见问题

### Q1: 如何调试 Strategy？

**A**: 使用单元测试 + 日志输出：

```javascript
propose(context, previousState) {
  console.log('[MyStrategy] Generation:', context.generation)
  console.log('[MyStrategy] Champion:', context.championId)
  console.log('[MyStrategy] State:', previousState)
  
  // ... strategy logic ...
  
  console.log('[MyStrategy] Plan:', plan)
  return { plan, state }
}
```

### Q2: 如何处理 Mutation Plan 验证失败？

**A**: Controller 会自动验证 Mutation Plan，如果违反约束（如 requires/conflicts、maximumRegionsPerPlan），会抛出 `ProtocolError`。确保在 propose 中手动检查这些约束。

### Q3: State 大小超过 64 KiB 怎么办？

**A**: 精简状态，只保留关键信息。例如，不要存储完整的搜索历史，只存储摘要统计。

### Q4: 如何实现多父节点 Mutation？

**A**: 当前版本只支持单父节点（`parentIds` 数组长度必须为 1）。多父节点支持在未来版本中提供。

### Q5: 如何测试 Docker Strategy？

**A**: 编写一个简单的 stdin/stdout 测试脚本：

```bash
echo '{"operation":"propose","context":{...},"state":null}' | docker run my-strategy-image
```

验证输出是否符合协议。

──────────────────────────────────────────

## 示例：Progressive Risk Expansion Strategy

完整实现参考：`controller/src/strategies/progressive-risk-expansion.mjs`

**核心思想**：从低风险层（L1）开始，连续失败后逐步扩展到更高风险层（L2 → L3）。

**配置**：
- `startRiskLevel`: 起始风险层（默认 'l1'）
- `missesBeforeExpansion`: 连续失败几次后扩展（默认 3）
- `regionSelection`: Region 选择策略（当前只支持 'all-under-active-risk-level'）

**状态**：
```javascript
{
  riskLevels: ['l1', 'l2', 'l3'],     // 可用风险层
  activeRiskLevel: 'l1',               // 当前活跃层
  consecutiveMisses: 0,                // 连续失败次数
  roundsProposed: 10,                  // 已提出轮次
  roundsObserved: 10,                  // 已观察轮次
  expansions: 1,                       // 风险扩展次数
  exhausted: false,                    // 是否耗尽
}
```

**逻辑**：
1. 从 L1 开始，随机选择该层的 Region
2. 观察结果：
   - 晋升 → 重置 `consecutiveMisses`
   - 失败 → `consecutiveMisses++`
3. 如果 `consecutiveMisses >= missesBeforeExpansion`，扩展到下一层
4. 如果已经在最高层且连续失败，标记 `exhausted: true`

──────────────────────────────────────────

## 参考资料

- **Mutation Catalog 规范**：`docs/mutation-catalog-spec.md`（如存在）
- **Selection Policy 规范**：`docs/selection-policy-spec.md`（如存在）
- **内置 Strategies**：
  - `controller/src/strategies/progressive-risk-expansion.mjs`
  - `controller/src/strategies/linear-hill-climb.mjs`（如存在）
- **实验配置示例**：`experiments/README.zh.md`

──────────────────────────────────────────

**版本**：v2.0  
**更新时间**：2025-01-29  
**维护者**：HarnessEvoGym RSI Team
