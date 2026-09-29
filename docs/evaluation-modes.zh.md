# 评测运行模式

HarnessEvoGym 把“能否复用旧结果”单独建模，避免把探索性实验误写成正式结果。

| 模式 | 用途 | 参数变化 | 旧结果处理 |
| --- | --- | --- | --- |
| `resume` | 继续同一个 Run | 不允许执行内容、Benchmark、模型、Provider、资源等身份变化 | 身份完全一致才允许复用 |
| `sealed-final` | 正式隐藏集评测 | 不允许身份变化，并且必须经过 Final 解封流程 | 只生成正式 Final 结果 |
| `fork` | 从已有 Checkpoint 派生新实验 | 可以改变模型、Provider、预算、超时等 | 记录 `parentRunId`，旧分数标记为过期，必须重新评测 |
| `exploratory` | 快速比较配置或调试 | 可以改变评测配置 | 只能生成探索报告，不能当作正式结果 |

评测身份由 `controller/src/evaluation-profile.mjs` 生成，内容只包含公开的实验参数和
摘要，不允许写入 API Key、Token、密码等凭据。摘要使用 SHA-256 固定下来，结果报告会记录
`evaluationMode` 和 `evaluationIdentityDigest`。

当前版本已经把身份校验接入通用 `Evaluator`。因此同一个 Run 的 `resume` 和正式
`sealed-final` 会继续保持严格 fail-closed；`fork` 与 `exploratory` 已有统一的过期标记
协议，但完整的“从 Checkpoint 创建新 Run”的 CLI 操作仍属于下一步工作。它不会修改旧 Run，
也不会把新参数下的分数覆盖到旧报告里。

## 代码示例

```js
import {
  compareEvaluationIdentity,
  createEvaluationIdentity,
} from '../controller/src/evaluation-profile.mjs'

const identity = createEvaluationIdentity({
  mode: 'fork',
  runId: 'officeval-fork-001',
  parentRunId: 'officeval-main-001',
  evaluation: {
    benchmark: 'officeval-v1',
    model: 'gpt-5.6-terra',
    provider: 'zcloud',
    timeoutSeconds: 7200,
  },
})

const reuse = compareEvaluationIdentity(previousIdentity, identity, { mode: 'fork' })
// reuse.reuse === 'stale'；旧分数只能参考，不能直接沿用。
```

Provider 凭据仍然只能通过运行时环境注入；不要把 Key 放入配置、Checkpoint 或评测身份。
