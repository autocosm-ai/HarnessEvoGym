# Fake Candidate

用于测试 Fake Environment 的示例 Candidate。

## 实现接口

Fake Environment 要求 Candidate 提供 `solve.mjs` 文件，导出 `solve()` 函数：

```javascript
export async function solve({ a, b, operation }) {
  // 根据 operation 执行相应计算
  // 返回数值结果
}
```

## 任务类型

- **add**: 返回 `a + b`
- **multiply**: 返回 `a * b`
- **square-sum**: 返回 `a * a + b * b`

## 评分

Fake Environment 会将 Candidate 的输出与正确答案比较：

- 输出 === 答案 → `accuracy: 1.0`
- 输出 !== 答案 → `accuracy: 0.0`

## 进化方向

Updater 可以尝试：

1. **优化延迟**：减少不必要的计算
2. **增加容错**：处理边界条件（负数、零、浮点数）
3. **扩展操作**：支持更多数学运算
4. **提前优化**：根据操作类型选择不同算法

## 使用示例

```bash
# 创建 Campaign（假设 Controller 已支持插件系统）
harness campaign create \
  --environment fake-deterministic-v1 \
  --target sdk/examples/fake-candidate \
  --config '{"taskCount": 10, "difficulty": "easy", "seed": 42}'

# 运行 baseline 试炼
harness campaign run baseline

# 启动进化
harness campaign run evolve --generations 5
```

## 故意引入错误的 Candidate

测试 Updater 修复能力：

```javascript
// solve-buggy.mjs
export async function solve({ a, b, operation }) {
  if (operation === 'add') {
    return a - b  // ❌ 故意写错
  }
  // ... 其他正确实现
}
```

Updater 应该从反馈中发现错误并修复。
