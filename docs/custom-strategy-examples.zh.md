# 自定义 Search Strategy 示例

本文档提供三个完整的自定义 Search Strategy 示例，从简单到复杂，帮助开发者快速上手。

──────────────────────────────────────────

## 示例 1：Random Strategy（随机策略）

最简单的 Strategy，随机选择父节点和 Region。

### 实现

```javascript
// controller/src/strategies/random-strategy.mjs

import { randomUUID } from 'node:crypto'
import { ProtocolError } from '../protocol.mjs'

export function createRandomStrategy(configuration) {
  // 配置验证
  const config = {
    seed: configuration.seed ?? Date.now(),
  }
  
  // 简单的伪随机数生成器（可选，使用 Math.random() 也可以）
  let rngState = config.seed
  function random() {
    rngState = (rngState * 1103515245 + 12345) & 0x7fffffff
    return rngState / 0x7fffffff
  }
  
  return {
    id: 'random-strategy',
    
    propose(context, previousState) {
      // 初始化状态
      const state = previousState ?? {
        roundsProposed: 0,
      }
      
      // 随机选择父节点（从 allowedParentIds 中）
      const parentId = context.allowedParentIds[
        Math.floor(random() * context.allowedParentIds.length)
      ]
      
      // 获取风险上限内的所有 Regions
      const availableRegions = context.catalog.spec.regions.filter(
        (region) => {
          const regionIndex = ['l1', 'l2', 'l3'].indexOf(region.riskLevel)
          const ceilingIndex = ['l1', 'l2', 'l3'].indexOf(context.riskCeiling)
          return regionIndex <= ceilingIndex
        }
      )
      
      if (availableRegions.length === 0) {
        throw new ProtocolError('No available regions within risk ceiling')
      }
      
      // 随机选择 1-3 个 Regions
      const maxRegions = Math.min(
        context.catalog.spec.maximumRegionsPerPlan ?? 3,
        availableRegions.length
      )
      const numRegions = Math.floor(random() * maxRegions) + 1
      
      // 简单随机采样（可能重复，这里用 Set 去重）
      const selectedRegions = new Set()
      while (selectedRegions.size < numRegions) {
        const region = availableRegions[
          Math.floor(random() * availableRegions.length)
        ]
        selectedRegions.add(region.id)
      }
      
      // 生成 Mutation Plan
      const plan = {
        apiVersion: 'harness-rsi/v1alpha1',
        kind: 'MutationPlan',
        metadata: {
          id: randomUUID(),
          strategy: this.id,
          generation: context.generation,
        },
        spec: {
          parentIds: [parentId],
          regionIds: Array.from(selectedRegions),
        },
      }
      
      // 更新状态
      state.roundsProposed += 1
      
      return { plan, state }
    },
    
    observe(outcome, previousState) {
      const state = { ...previousState }
      
      // Random Strategy 不需要根据结果调整行为
      // 但仍然可以记录统计信息
      state.lastOutcome = outcome.status
      
      // 永不 exhaust（让 Evolution 控制停止）
      const exhausted = false
      
      return { state, exhausted }
    },
  }
}
```

### Adapter

```yaml
# adapters/strategies/random-strategy.yml

apiVersion: harness-rsi/v1alpha1
kind: SearchStrategyAdapter

metadata:
  id: random-strategy
  name: Random Strategy

spec:
  protocol: builtin-v1
  implementation: random-strategy
  configuration:
    seed: 20250129
```

### 测试

```javascript
// controller/test/random-strategy.test.mjs

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRandomStrategy } from '../src/strategies/random-strategy.mjs'

describe('Random Strategy', () => {
  it('propose 选择有效的父节点和 Regions', () => {
    const strategy = createRandomStrategy({ seed: 12345 })
    
    const context = {
      runId: 'test-run',
      generation: 1,
      riskCeiling: 'l2',
      catalog: {
        spec: {
          maximumRegionsPerPlan: 3,
          regions: [
            { id: 'r1', riskLevel: 'l1' },
            { id: 'r2', riskLevel: 'l1' },
            { id: 'r3', riskLevel: 'l2' },
          ],
        },
      },
      championId: 'baseline',
      allowedParentIds: ['baseline', 'g001-l1'],
      candidates: [],
      searchHistory: [],
    }
    
    const result = strategy.propose(context, null)
    
    // 验证 plan 结构
    assert.ok(result.plan)
    assert.equal(result.plan.apiVersion, 'harness-rsi/v1alpha1')
    assert.equal(result.plan.kind, 'MutationPlan')
    
    // 验证父节点在 allowedParentIds 中
    assert.ok(context.allowedParentIds.includes(result.plan.spec.parentIds[0]))
    
    // 验证 regionIds 数量和有效性
    assert.ok(result.plan.spec.regionIds.length > 0)
    assert.ok(result.plan.spec.regionIds.length <= 3)
    result.plan.spec.regionIds.forEach((id) => {
      assert.ok(['r1', 'r2', 'r3'].includes(id))
    })
  })
  
  it('observe 不会标记 exhausted', () => {
    const strategy = createRandomStrategy({})
    
    const outcome = {
      status: 'rejected',
      championId: 'baseline',
    }
    
    const result = strategy.observe(outcome, { roundsProposed: 1 })
    
    assert.equal(result.exhausted, false)
  })
})
```

──────────────────────────────────────────

## 示例 2：Greedy Best-First Strategy（贪心最优先策略）

总是选择最近晋升的 Candidate 作为父节点，优先探索高 reward 分支。

### 实现

```javascript
// controller/src/strategies/greedy-best-first.mjs

import { randomUUID } from 'node:crypto'
import { ProtocolError } from '../protocol.mjs'

export function createGreedyBestFirstStrategy(configuration) {
  const config = {
    riskLevel: configuration.riskLevel ?? 'l1',
    regionRotation: configuration.regionRotation ?? 'round-robin',
  }
  
  // 验证配置
  if (!['l1', 'l2', 'l3'].includes(config.riskLevel)) {
    throw new ProtocolError('riskLevel must be l1, l2, or l3')
  }
  
  if (!['round-robin', 'random'].includes(config.regionRotation)) {
    throw new ProtocolError('regionRotation must be round-robin or random')
  }
  
  return {
    id: 'greedy-best-first',
    
    propose(context, previousState) {
      // 初始化状态
      const state = previousState ?? {
        riskLevel: config.riskLevel,
        regionIndex: 0,
        roundsProposed: 0,
      }
      
      // 总是选择当前 Champion 作为父节点
      const parentId = context.championId
      
      // 获取指定风险层的 Regions
      const availableRegions = context.catalog.spec.regions.filter(
        (region) => region.riskLevel === state.riskLevel
      )
      
      if (availableRegions.length === 0) {
        throw new ProtocolError(`No regions at risk level ${state.riskLevel}`)
      }
      
      // 选择 Region
      let selectedRegionId
      if (config.regionRotation === 'round-robin') {
        // 轮询选择
        selectedRegionId = availableRegions[state.regionIndex % availableRegions.length].id
        state.regionIndex += 1
      } else {
        // 随机选择
        selectedRegionId = availableRegions[
          Math.floor(Math.random() * availableRegions.length)
        ].id
      }
      
      // 生成 Mutation Plan
      const plan = {
        apiVersion: 'harness-rsi/v1alpha1',
        kind: 'MutationPlan',
        metadata: {
          id: randomUUID(),
          strategy: this.id,
          generation: context.generation,
        },
        spec: {
          parentIds: [parentId],
          regionIds: [selectedRegionId],
        },
      }
      
      state.roundsProposed += 1
      
      return { plan, state }
    },
    
    observe(outcome, previousState) {
      const state = { ...previousState }
      
      // 记录最后一次结果
      state.lastPromoted = outcome.status === 'promoted'
      
      // 如果所有 Regions 都尝试过且没有晋升，标记 exhausted
      const availableRegionsCount = 10 // 简化，实际应从 catalog 获取
      const exhausted = state.regionIndex >= availableRegionsCount && !state.lastPromoted
      
      return { state, exhausted }
    },
  }
}
```

### Adapter

```yaml
# adapters/strategies/greedy-best-first.yml

apiVersion: harness-rsi/v1alpha1
kind: SearchStrategyAdapter

metadata:
  id: greedy-best-first
  name: Greedy Best-First Strategy

spec:
  protocol: builtin-v1
  implementation: greedy-best-first
  configuration:
    riskLevel: l1
    regionRotation: round-robin
```

──────────────────────────────────────────

## 示例 3：UCB (Upper Confidence Bound) Strategy

使用 UCB 算法平衡 exploration（探索未尝试的 Regions）和 exploitation（利用已知高 reward 的 Regions）。

### 实现

```javascript
// controller/src/strategies/ucb-strategy.mjs

import { randomUUID } from 'node:crypto'
import { ProtocolError } from '../protocol.mjs'

export function createUCBStrategy(configuration) {
  const config = {
    explorationFactor: configuration.explorationFactor ?? 1.41, // √2
    riskLevel: configuration.riskLevel ?? 'l1',
  }
  
  if (!Number.isFinite(config.explorationFactor) || config.explorationFactor < 0) {
    throw new ProtocolError('explorationFactor must be non-negative number')
  }
  
  return {
    id: 'ucb-strategy',
    
    propose(context, previousState) {
      // 初始化状态
      const state = previousState ?? {
        riskLevel: config.riskLevel,
        regionStats: {}, // regionId -> { attempts, successes }
        totalAttempts: 0,
      }
      
      // 选择父节点：当前 Champion
      const parentId = context.championId
      
      // 获取可用 Regions
      const availableRegions = context.catalog.spec.regions.filter(
        (region) => region.riskLevel === state.riskLevel
      )
      
      if (availableRegions.length === 0) {
        throw new ProtocolError(`No regions at risk level ${state.riskLevel}`)
      }
      
      // 计算每个 Region 的 UCB 值
      const ucbValues = availableRegions.map((region) => {
        const stats = state.regionStats[region.id] ?? { attempts: 0, successes: 0 }
        
        if (stats.attempts === 0) {
          // 未尝试过的 Region，给予最高优先级
          return { regionId: region.id, ucb: Infinity }
        }
        
        const successRate = stats.successes / stats.attempts
        const explorationBonus = config.explorationFactor * Math.sqrt(
          Math.log(state.totalAttempts) / stats.attempts
        )
        const ucb = successRate + explorationBonus
        
        return { regionId: region.id, ucb }
      })
      
      // 选择 UCB 值最高的 Region
      ucbValues.sort((a, b) => b.ucb - a.ucb)
      const selectedRegionId = ucbValues[0].regionId
      
      // 生成 Mutation Plan
      const plan = {
        apiVersion: 'harness-rsi/v1alpha1',
        kind: 'MutationPlan',
        metadata: {
          id: randomUUID(),
          strategy: this.id,
          generation: context.generation,
        },
        spec: {
          parentIds: [parentId],
          regionIds: [selectedRegionId],
        },
      }
      
      return { plan, state }
    },
    
    observe(outcome, previousState) {
      const state = { ...previousState }
      
      // 更新统计信息
      const regionId = outcome.regionIds[0] // 假设单 Region
      if (!state.regionStats[regionId]) {
        state.regionStats[regionId] = { attempts: 0, successes: 0 }
      }
      
      state.regionStats[regionId].attempts += 1
      state.totalAttempts += 1
      
      if (outcome.status === 'promoted') {
        state.regionStats[regionId].successes += 1
      }
      
      // 如果所有 Regions 都尝试过至少 N 次且成功率都很低，标记 exhausted
      const allRegionsExplored = Object.values(state.regionStats).every(
        (stats) => stats.attempts >= 3
      )
      const allRegionsLowSuccess = Object.values(state.regionStats).every(
        (stats) => stats.successes / stats.attempts < 0.1
      )
      const exhausted = allRegionsExplored && allRegionsLowSuccess
      
      return { state, exhausted }
    },
  }
}
```

### Adapter

```yaml
# adapters/strategies/ucb-strategy.yml

apiVersion: harness-rsi/v1alpha1
kind: SearchStrategyAdapter

metadata:
  id: ucb-strategy
  name: UCB Strategy

spec:
  protocol: builtin-v1
  implementation: ucb-strategy
  configuration:
    explorationFactor: 1.41    # √2，标准 UCB 参数
    riskLevel: l1
```

### 测试

```javascript
// controller/test/ucb-strategy.test.mjs

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createUCBStrategy } from '../src/strategies/ucb-strategy.mjs'

describe('UCB Strategy', () => {
  it('优先选择未尝试过的 Region', () => {
    const strategy = createUCBStrategy({ riskLevel: 'l1' })
    
    const context = {
      generation: 1,
      riskCeiling: 'l1',
      catalog: {
        spec: {
          regions: [
            { id: 'r1', riskLevel: 'l1' },
            { id: 'r2', riskLevel: 'l1' },
          ],
        },
      },
      championId: 'baseline',
      allowedParentIds: ['baseline'],
      candidates: [],
      searchHistory: [],
    }
    
    // 状态：r1 已尝试过，r2 未尝试
    const state = {
      riskLevel: 'l1',
      regionStats: {
        r1: { attempts: 1, successes: 0 },
      },
      totalAttempts: 1,
    }
    
    const result = strategy.propose(context, state)
    
    // 应该选择未尝试的 r2
    assert.equal(result.plan.spec.regionIds[0], 'r2')
  })
  
  it('observe 正确更新统计信息', () => {
    const strategy = createUCBStrategy({})
    
    const outcome = {
      status: 'promoted',
      regionIds: ['r1'],
    }
    
    const state = {
      regionStats: {
        r1: { attempts: 1, successes: 0 },
      },
      totalAttempts: 1,
    }
    
    const result = strategy.observe(outcome, state)
    
    assert.equal(result.state.regionStats.r1.attempts, 2)
    assert.equal(result.state.regionStats.r1.successes, 1)
    assert.equal(result.state.totalAttempts, 2)
  })
})
```

──────────────────────────────────────────

## 注册与使用

### 注册 Strategy

在 `controller/src/search-strategy.mjs` 中注册：

```javascript
import { createRandomStrategy } from './strategies/random-strategy.mjs'
import { createGreedyBestFirstStrategy } from './strategies/greedy-best-first.mjs'
import { createUCBStrategy } from './strategies/ucb-strategy.mjs'

registerBuiltinSearchStrategy('random-strategy', createRandomStrategy)
registerBuiltinSearchStrategy('greedy-best-first', createGreedyBestFirstStrategy)
registerBuiltinSearchStrategy('ucb-strategy', createUCBStrategy)
```

### 在实验中使用

```json
{
  "experiment": {
    "bundle": {
      "strategy": "adapters/strategies/ucb-strategy.yml"
    }
  }
}
```

──────────────────────────────────────────

## 对比总结

| Strategy | 特点 | 适用场景 | 优点 | 缺点 |
|----------|------|---------|------|------|
| **Random** | 完全随机选择 | 基线对比、探索性搜索 | 简单、无偏 | 效率低，易错过最优解 |
| **Greedy Best-First** | 总是选择当前最优分支 | 快速收敛到局部最优 | 快速、直接 | 易陷入局部最优 |
| **UCB** | 平衡探索与利用 | 需要全局搜索的场景 | 理论保证、全面 | 复杂度较高 |
| **Progressive Risk** | 逐步扩大风险层 | 稳健的进化路径 | 稳定、可控 | 可能错过跨层级组合 |

──────────────────────────────────────────

**版本**：v1.0  
**更新时间**：2025-01-29
