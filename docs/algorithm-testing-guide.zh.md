# Algorithm SDK 测试指南

本指南提供完整的 Search Strategy 测试方法，包括单元测试、集成测试和调试技巧。

──────────────────────────────────────────

## 测试层级

```
┌─────────────────────────────────────┐
│  单元测试                            │  测试 propose() 和 observe() 逻辑
│  - 快速（< 1s）                      │
│  - 隔离（mock context）              │
│  - 完整覆盖边界情况                   │
└─────────────────────────────────────┘
                ↓
┌─────────────────────────────────────┐
│  集成测试                            │  测试 Strategy 在真实 Evolution 中的表现
│  - 较慢（分钟级）                     │
│  - 真实环境                          │
│  - 验证端到端流程                     │
└─────────────────────────────────────┘
                ↓
┌─────────────────────────────────────┐
│  性能测试                            │  测试大规模场景下的性能
│  - 慢（小时级）                       │
│  - 压力测试                          │
│  - 资源消耗分析                       │
└─────────────────────────────────────┘
```

──────────────────────────────────────────

## 单元测试

### 基本测试模板

```javascript
// controller/test/my-strategy.test.mjs

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createMyStrategy } from '../src/strategies/my-strategy.mjs'

describe('My Strategy', () => {
  // 测试 1：初始化
  it('正确初始化状态', () => {
    const strategy = createMyStrategy({ startLevel: 'l1' })
    
    const context = createMockContext()
    const result = strategy.propose(context, null)
    
    assert.ok(result.state)
    assert.equal(result.state.initialized, true)
  })
  
  // 测试 2：propose 逻辑
  it('propose 返回有效的 Mutation Plan', () => {
    const strategy = createMyStrategy({})
    
    const context = createMockContext()
    const result = strategy.propose(context, null)
    
    // 验证 plan 结构
    assert.equal(result.plan.apiVersion, 'harness-rsi/v1alpha1')
    assert.equal(result.plan.kind, 'MutationPlan')
    assert.ok(result.plan.metadata.id)
    
    // 验证 parentIds
    assert.ok(Array.isArray(result.plan.spec.parentIds))
    assert.equal(result.plan.spec.parentIds.length, 1)
    assert.ok(context.allowedParentIds.includes(result.plan.spec.parentIds[0]))
    
    // 验证 regionIds
    assert.ok(Array.isArray(result.plan.spec.regionIds))
    assert.ok(result.plan.spec.regionIds.length > 0)
  })
  
  // 测试 3：observe 逻辑
  it('observe 在晋升后更新状态', () => {
    const strategy = createMyStrategy({})
    
    const outcome = createMockOutcome({ status: 'promoted' })
    const previousState = { attempts: 1 }
    
    const result = strategy.observe(outcome, previousState)
    
    assert.ok(result.state)
    assert.equal(result.exhausted, false)
  })
  
  // 测试 4：exhaustion 逻辑
  it('在搜索空间耗尽后标记 exhausted', () => {
    const strategy = createMyStrategy({ maxAttempts: 3 })
    
    let state = { attempts: 0 }
    
    for (let i = 0; i < 3; i += 1) {
      const outcome = createMockOutcome({ status: 'rejected' })
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

// 辅助函数：创建 mock context
function createMockContext() {
  return {
    runId: 'test-run',
    generation: 1,
    riskCeiling: 'l2',
    catalog: {
      apiVersion: 'harness-rsi/v1alpha1',
      kind: 'MutationCatalog',
      metadata: { target: 'test-target' },
      spec: {
        riskLevels: ['l1', 'l2', 'l3'],
        maximumRegionsPerPlan: 3,
        regions: [
          {
            id: 'region-1',
            description: 'Test region 1',
            riskLevel: 'l1',
            requires: [],
            conflicts: [],
          },
          {
            id: 'region-2',
            description: 'Test region 2',
            riskLevel: 'l2',
            requires: [],
            conflicts: [],
          },
        ],
      },
    },
    championId: 'baseline',
    allowedParentIds: ['baseline', 'g001-l1'],
    candidates: [
      { id: 'baseline', parentId: null, digest: 'abc123', status: 'promoted' },
      { id: 'g001-l1', parentId: 'baseline', digest: 'def456', status: 'promoted' },
    ],
    searchHistory: [],
  }
}

// 辅助函数：创建 mock outcome
function createMockOutcome(overrides = {}) {
  return {
    runId: 'test-run',
    generation: 1,
    parentId: 'baseline',
    proposalId: 'g001-l1',
    status: 'rejected',
    championId: 'baseline',
    regionIds: ['region-1'],
    ...overrides,
  }
}
```

### 测试检查清单

**propose() 测试**：
- ✅ 初始状态（previousState === null）
- ✅ 继续状态（previousState !== null）
- ✅ parentIds 在 allowedParentIds 中
- ✅ regionIds 在 catalog 中存在
- ✅ regionIds 不超过 maximumRegionsPerPlan
- ✅ regionIds 符合 requires/conflicts 约束
- ✅ regionIds 的 riskLevel 不超过 riskCeiling
- ✅ plan.metadata.id 唯一
- ✅ state 可 JSON 序列化
- ✅ state 大小 <= 64 KiB

**observe() 测试**：
- ✅ 处理 promoted 结果
- ✅ 处理 rejected 结果
- ✅ 处理 invalid-proposal 结果
- ✅ 状态正确更新
- ✅ exhausted 逻辑正确
- ✅ state 可 JSON 序列化

### 边界情况测试

```javascript
describe('My Strategy - 边界情况', () => {
  it('只有一个 Region 可选时正常工作', () => {
    const strategy = createMyStrategy({})
    
    const context = createMockContext()
    context.catalog.spec.regions = [
      { id: 'only-region', riskLevel: 'l1', requires: [], conflicts: [] },
    ]
    
    const result = strategy.propose(context, null)
    
    assert.deepEqual(result.plan.spec.regionIds, ['only-region'])
  })
  
  it('所有父节点都被拒绝后仍能选择', () => {
    const strategy = createMyStrategy({})
    
    const context = createMockContext()
    context.candidates = [
      { id: 'c1', status: 'rejected' },
      { id: 'c2', status: 'rejected' },
    ]
    context.allowedParentIds = ['baseline'] // 只剩 baseline
    
    const result = strategy.propose(context, null)
    
    assert.equal(result.plan.spec.parentIds[0], 'baseline')
  })
  
  it('riskCeiling 限制生效', () => {
    const strategy = createMyStrategy({})
    
    const context = createMockContext()
    context.riskCeiling = 'l1' // 只允许 L1
    context.catalog.spec.regions = [
      { id: 'r1', riskLevel: 'l1', requires: [], conflicts: [] },
      { id: 'r2', riskLevel: 'l2', requires: [], conflicts: [] },
      { id: 'r3', riskLevel: 'l3', requires: [], conflicts: [] },
    ]
    
    const result = strategy.propose(context, null)
    
    // 只能选择 L1 的 Region
    assert.deepEqual(result.plan.spec.regionIds, ['r1'])
  })
  
  it('处理空 searchHistory', () => {
    const strategy = createMyStrategy({})
    
    const context = createMockContext()
    context.searchHistory = []
    
    assert.doesNotThrow(() => {
      strategy.propose(context, null)
    })
  })
  
  it('处理大状态（接近 64 KiB）', () => {
    const strategy = createMyStrategy({})
    
    const largeState = {
      data: 'x'.repeat(60 * 1024), // 60 KiB
    }
    
    const outcome = createMockOutcome()
    
    assert.doesNotThrow(() => {
      strategy.observe(outcome, largeState)
    })
  })
})
```

### 运行单元测试

```bash
# 运行所有测试
node --test controller/test/my-strategy.test.mjs

# 运行特定测试
node --test controller/test/my-strategy.test.mjs --test-name-pattern="初始化"

# 生成覆盖率报告
node --test --experimental-test-coverage controller/test/my-strategy.test.mjs
```

──────────────────────────────────────────

## 集成测试

### 创建测试实验配置

```json
{
  "apiVersion": "harness-rsi/v1alpha1",
  "kind": "Experiment",
  "metadata": {
    "id": "integration-test-my-strategy"
  },
  "spec": {
    "bundle": {
      "target": "targets/text-reasoning/target.yml",
      "updater": "adapters/updaters/deepseek-harness.yml",
      "environment": "environments/text-reasoning-smoke.yml",
      "provider": "adapters/providers/zcloud-openai.yml",
      "strategy": "adapters/strategies/my-strategy.yml"
    },
    "benchmark": "benchmarks/text-reasoning-smoke/benchmark.json",
    "policy": "evaluation/policies/relaxed-any-improvement.json",
    "models": {
      "solver": {
        "provider": "zcloud-openai",
        "model": "gpt-5.6-terra",
        "maxTokens": 4096
      },
      "updater": {
        "provider": "zcloud-openai",
        "model": "gpt-5.6-terra",
        "maxTokens": 4096
      }
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

### 运行集成测试

```bash
# 运行实验
node controller/src/cli.mjs run experiments/integration-test-my-strategy.json

# 检查结果
ls -lh /tmp/harness-rsi-runs/
```

### 验证清单

**基础验证**：
- ✅ Evolution 成功完成所有 generations
- ✅ 没有 ProtocolError 或 CandidateMutationError
- ✅ 每一代都产生了 Mutation Plan
- ✅ state.json 文件存在且结构正确

**逻辑验证**：
- ✅ searchHistory 记录完整
- ✅ Strategy 状态演化符合预期
- ✅ exhausted 机制触发正确
- ✅ 晋升决策合理

**数据验证**：
```bash
# 检查 state.json
cat /tmp/harness-rsi-runs/<run-id>/state.json | jq '.spec.searchStrategyState'

# 检查 searchHistory
cat /tmp/harness-rsi-runs/<run-id>/state.json | jq '.spec.searchHistory[]'

# 检查是否有晋升
cat /tmp/harness-rsi-runs/<run-id>/state.json | jq '.spec.candidates[] | select(.status == "promoted")'
```

──────────────────────────────────────────

## 调试技巧

### 1. 添加日志输出

```javascript
propose(context, previousState) {
  console.log('[MyStrategy] propose called')
  console.log('  generation:', context.generation)
  console.log('  championId:', context.championId)
  console.log('  previousState:', JSON.stringify(previousState, null, 2))
  
  const result = { plan, state }
  
  console.log('  selected parentId:', result.plan.spec.parentIds[0])
  console.log('  selected regionIds:', result.plan.spec.regionIds)
  console.log('  new state:', JSON.stringify(result.state, null, 2))
  
  return result
}
```

### 2. 导出中间状态

```javascript
propose(context, previousState) {
  // 导出 context 用于离线分析
  const fs = require('node:fs')
  fs.writeFileSync(
    `/tmp/my-strategy-context-gen${context.generation}.json`,
    JSON.stringify(context, null, 2)
  )
  
  // ... strategy logic ...
}
```

### 3. 使用断点调试

```javascript
// 在关键位置设置 debugger
propose(context, previousState) {
  debugger // 断点
  
  const availableRegions = context.catalog.spec.regions.filter(/* ... */)
  
  debugger // 断点
  
  return { plan, state }
}
```

运行：
```bash
node --inspect-brk controller/src/cli.mjs run experiments/test.json
```

然后在 Chrome 中打开 `chrome://inspect`。

### 4. 模拟特定场景

```javascript
// 测试特定的 searchHistory 场景
it('处理连续失败场景', () => {
  const strategy = createMyStrategy({})
  
  const context = createMockContext()
  context.searchHistory = [
    { generation: 1, status: 'rejected', regionIds: ['r1'] },
    { generation: 2, status: 'rejected', regionIds: ['r2'] },
    { generation: 3, status: 'rejected', regionIds: ['r3'] },
  ]
  
  const result = strategy.propose(context, { failures: 3 })
  
  // 验证 Strategy 是否调整策略
  assert.notEqual(result.plan.spec.regionIds[0], 'r1')
  assert.notEqual(result.plan.spec.regionIds[0], 'r2')
  assert.notEqual(result.plan.spec.regionIds[0], 'r3')
})
```

──────────────────────────────────────────

## 性能测试

### 测试 propose() 性能

```javascript
import { performance } from 'node:perf_hooks'

it('propose 在 100ms 内完成', () => {
  const strategy = createMyStrategy({})
  const context = createLargeContext() // 1000+ regions
  
  const start = performance.now()
  strategy.propose(context, null)
  const duration = performance.now() - start
  
  assert.ok(duration < 100, `propose took ${duration}ms`)
})
```

### 测试状态大小

```javascript
it('状态大小不超过 64 KiB', () => {
  const strategy = createMyStrategy({})
  
  let state = null
  for (let i = 0; i < 100; i += 1) {
    const context = createMockContext()
    const result = strategy.propose(context, state)
    state = result.state
  }
  
  const stateSize = Buffer.byteLength(JSON.stringify(state), 'utf8')
  assert.ok(stateSize <= 64 * 1024, `State size: ${stateSize} bytes`)
})
```

### 测试大规模 Evolution

```json
{
  "evolution": {
    "mutationLevel": "l3",
    "generations": 50,
    "trialsPerInstance": 3,
    "seeds": [1, 2, 3, 4, 5]
  }
}
```

监控：
- CPU 使用率
- 内存使用量
- 单代耗时
- 状态大小增长

──────────────────────────────────────────

## 持续集成

### GitHub Actions 配置

```yaml
# .github/workflows/test-strategies.yml

name: Test Strategies

on: [push, pull_request]

jobs:
  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
      
      - name: Run unit tests
        run: |
          cd controller
          node --test test/*-strategy.test.mjs
  
  integration-tests:
    runs-on: ubuntu-latest
    if: github.event_name == 'push'
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
      
      - name: Run integration tests
        run: |
          node controller/src/cli.mjs run experiments/integration-test-*.json
```

──────────────────────────────────────────

## 常见问题排查

### Q1: ProtocolError: Strategy 返回的 state 无法序列化

**原因**：state 包含循环引用或特殊对象

**解决**：
```javascript
// 错误示例
const state = { parent: null }
state.parent = state // 循环引用

// 正确示例
const state = { parentId: 'baseline' }
```

### Q2: ProtocolError: regionIds 违反 requires 约束

**原因**：选择了 Region A 但未选择它依赖的 Region B

**解决**：
```javascript
function selectRegionsWithDependencies(selectedIds, catalog) {
  const result = new Set(selectedIds)
  
  for (const id of selectedIds) {
    const region = catalog.spec.regions.find((r) => r.id === id)
    region.requires.forEach((reqId) => result.add(reqId))
  }
  
  return Array.from(result)
}
```

### Q3: Strategy 提前 exhausted

**原因**：exhausted 判断条件过于严格

**解决**：放宽条件或增加重试次数
```javascript
// 错误：一次失败就 exhausted
const exhausted = outcome.status === 'rejected'

// 正确：连续多次失败才 exhausted
const exhausted = state.consecutiveFailures >= 5
```

──────────────────────────────────────────

## 最佳实践总结

1. **先写单元测试，再写代码**：TDD 方法确保逻辑正确
2. **覆盖边界情况**：空输入、单元素、极大值
3. **模拟真实场景**：使用历史 searchHistory 构造测试
4. **添加调试日志**：关键决策点输出日志
5. **集成测试验证**：确保 Strategy 在真实 Evolution 中工作
6. **性能测试**：验证大规模场景下的性能

──────────────────────────────────────────

**版本**：v1.0  
**更新时间**：2025-01-29
