# Fake Environment

无需 API Key 的示例 Environment，用于：

1. 测试插件发现和加载系统
2. 开发新的 Evolution Algorithm
3. 验证 Candidate 接口实现
4. 快速原型验证

## 任务格式

每个任务是一个简单的数学题：

```json
{
  "id": "training-task-1",
  "partition": "training",
  "input": {
    "a": 42,
    "b": 17,
    "operation": "add"  // 或 "multiply" / "square-sum"
  },
  "answer": 59
}
```

## Candidate 接口

Candidate 必须提供 `solve.mjs` 文件，导出 `solve()` 函数：

```javascript
// solve.mjs
export async function solve({ a, b, operation }) {
  if (operation === 'add') return a + b
  if (operation === 'multiply') return a * b
  if (operation === 'square-sum') return a * a + b * b
  throw new Error(`Unknown operation: ${operation}`)
}
```

## 配置参数

```yaml
environment:
  protocol: fake-deterministic-v1
  config:
    taskCount: 10        # 每个分区的任务数量（1-100）
    difficulty: easy     # 任务难度：easy / medium / hard
    seed: 12345          # 随机种子（确保可复现）
```

## 评分标准

- **accuracy**: Candidate 输出是否等于正确答案（0.0 或 1.0）
- **latency**: 模拟延迟（0-100 毫秒，随机生成）
- **reward**: `accuracy * 100 - latency * 0.1`
- **promotion**: `avgAccuracy >= 0.8`

## 使用示例

```bash
# 验证插件清单
harness plugin validate sdk/examples/fake-environment

# 注册到本地 Controller
harness plugin register sdk/examples/fake-environment

# 创建使用 Fake Environment 的 Campaign
harness campaign create \
  --environment fake-deterministic-v1 \
  --target ./my-solver \
  --config '{"taskCount": 20, "difficulty": "medium"}'
```
