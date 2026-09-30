# 测试指南

本文档说明 HarnessEvoGym RSI 的测试策略、测试分类、编写规范和调试方法。

## 测试分类

### 单元测试（Unit Tests）

**特征**：快速、无外部依赖、隔离测试单个函数或模块

**位置**：`controller/test/*.test.mjs`

**示例**：

```javascript
// controller/test/protocol.test.mjs
test('validateBenchmark 拒绝缺少 metadata.id 的配置', () => {
  const invalid = {
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'Benchmark',
    metadata: {},  // 缺少 id
    spec: { /* ... */ }
  }
  
  assert.throws(
    () => validateBenchmark(invalid),
    /metadata.id/
  )
})
```

**运行**：

```bash
npm test  # 运行所有单元测试
node --test controller/test/protocol.test.mjs  # 单个文件
```

### 集成测试（Integration Tests）

**特征**：需要 Docker、文件系统或多个模块协作

**命名**：`*-integration.test.mjs`

**示例**：

```javascript
// controller/test/docker-integration.test.mjs
test('Docker 容器网络隔离验证', async () => {
  const client = new DockerClient({ network: 'none' })
  
  const result = await client.run({
    image: 'alpine:latest',
    command: ['ping', '-c', '1', '8.8.8.8'],
    timeoutSeconds: 10
  })
  
  // network=none 模式下 ping 应该失败
  assert.notEqual(result.exitCode, 0)
})
```

**运行**：

```bash
node --test controller/test/docker-integration.test.mjs
```

### 端到端测试（E2E Tests）

**特征**：完整流程验证，从输入到输出

**命名**：`*-e2e.test.mjs` 或 `*-e2e-*.test.mjs`

**示例**：

```javascript
// controller/test/harbor-e2e-smoke.test.mjs
test('Harbor 端到端冒烟测试', async () => {
  // 1. 准备 Environment
  const environment = await loadEnvironment('harbor')
  
  // 2. 物化 Candidate
  const candidate = await materializeCandidate(h0Seed)
  
  // 3. 运行评测
  const results = await environment.runCandidatePartition({
    candidateId: 'test-001',
    partition: 'feedback',
    seeds: [42]
  })
  
  // 4. 验证结果
  assert.ok(results.size > 0)
  for (const [instanceId, result] of results) {
    assert.ok(['resolved', 'unresolved', 'failed'].includes(result.status))
  }
})
```

**运行**：

```bash
# Harbor Docker 冒烟测试（需要 Docker；普通 npm test 默认跳过）
npm run test:docker

# 完整 E2E（需要数据集）
export RSI_OFFICEVAL_DATASET_ROOT="$PWD/../datasets/OmegaUse-OfficeVal-Dataset"
node --test controller/test/omegause-offline-e2e.test.mjs
```

## 测试编写规范

### 条件跳过

需要外部资源的测试应该条件跳过，而不是硬编码路径：

```javascript
const skipTest = !process.env.RSI_OFFICEVAL_DATASET_ROOT
  || !process.env.RSI_OFFICEVAL_EVALUATOR_ROOT

test('OmegaUse 离线验证', { skip: skipTest }, async () => {
  // 测试代码
})
```

**原因**：
- CI 环境可能没有完整数据集
- 开发者可以选择性运行
- 避免测试意外失败

### 清理资源

测试应该在 `finally` 块中清理临时资源：

```javascript
test('Environment 工作区隔离', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'test-'))
  
  try {
    // 测试逻辑
    await runTest(tmpDir)
  } finally {
    // 清理临时目录
    await rm(tmpDir, { recursive: true, force: true })
  }
})
```

### 避免硬编码超时

使用合理的超时值，并提供可调整的环境变量：

```javascript
const timeout = parseInt(process.env.TEST_TIMEOUT_MS || '60000', 10)

test('长运行任务', { timeout }, async () => {
  // 测试逻辑
})
```

### 明确断言消息

断言失败时应该提供清晰的上下文：

```javascript
// 不好
assert.equal(result.status, 'resolved')

// 好
assert.equal(
  result.status,
  'resolved',
  `题目 ${instanceId} 应该解决，但状态是 ${result.status}`
)
```

## 测试覆盖矩阵

### Environment 测试

| 测试点 | 验证内容 |
|-------|---------|
| **Preflight** | 数据集存在、Revision 匹配、镜像可用 |
| **Workspace** | 工作区隔离、文件权限、大小限制 |
| **Solver 调用** | Candidate 只读、Task 可写、网络隔离 |
| **Verifier** | 独立运行、无网络、只读 Submission |
| **Result 格式** | 符合 v2 协议、必填字段完整 |
| **Resume** | 中断后恢复、Checkpoint 一致性 |
| **Partition 隔离** | feedback 有反馈、selection 无反馈、final 密封 |

**示例**：

```javascript
test('OmegaUse Workspace 隔离验证', async () => {
  const env = new OmegaUseOfficeValEnvironment({ /* config */ })
  
  // 运行两个 Trial
  await env.runTrial({ instanceId: 'task001', seed: 42 })
  await env.runTrial({ instanceId: 'task002', seed: 43 })
  
  // 验证工作区独立
  const task001Files = await readdir(join(runRoot, 'task001'))
  const task002Files = await readdir(join(runRoot, 'task002'))
  
  assert.ok(!task001Files.some(f => f.includes('task002')))
  assert.ok(!task002Files.some(f => f.includes('task001')))
})
```

### SearchStrategy 测试

| 测试点 | 验证内容 |
|-------|---------|
| **Context 脱敏** | 不包含凭据、Final 题目、完整路径 |
| **Region 白名单** | 只返回 Catalog 中的 Region |
| **Risk Ceiling** | 不超出配置的风险层 |
| **State 可序列化** | JSON.stringify + parse 幂等 |
| **Exhaustion** | 正确标记穷尽状态 |

**示例**：

```javascript
test('SearchStrategy 不能返回 Catalog 外的 Region', () => {
  const catalog = [
    { id: 'skill-guidance', riskLevel: 'l1' },
    { id: 'agent-loop', riskLevel: 'l2' }
  ]
  
  const result = linearHillClimb({
    context: { /* ... */ },
    state: null,
    catalog,
    riskCeiling: 'l2'
  })
  
  for (const regionId of result.regionIds) {
    assert.ok(
      catalog.some(r => r.id === regionId),
      `Region ${regionId} 不在 Catalog 中`
    )
  }
})
```

### Updater 测试

| 测试点 | 验证内容 |
|-------|---------|
| **MutationLease** | 只能写 Lease 允许的文件 |
| **Diff 验证** | Controller 能检测越权修改 |
| **网络隔离** | 只能通过 Gateway 访问模型 |
| **报告格式** | Mutation Report 符合协议 |
| **Stop 协议** | 收到 SIGTERM 能正常退出 |

**示例**：

```javascript
test('Updater 不能修改 Lease 外的文件', async () => {
  const lease = {
    writablePaths: ['skills/example.md'],
    readonlyPaths: ['profile.json']
  }
  
  const updater = new CodexUpdater({ lease })
  
  // 尝试修改只读文件
  await assert.rejects(
    () => updater.modifyFile('profile.json', 'hacked'),
    /不在 MutationLease 允许的写入路径/
  )
})
```

## Mock 策略

### Mock Solver

用于测试 Environment 而不依赖真实模型：

```javascript
const mockSolver = {
  id: 'test-solver',
  async ensureRuntime({ baseImage }) {
    return { image: baseImage, identity: baseImage }
  },
  async run({ taskWorkspace }) {
    // 生成最小交付物
    await writeFile(
      join(taskWorkspace, 'answer.txt'),
      'mock answer'
    )
    return { exitCode: 0 }
  }
}
```

### Mock Verifier

用于测试 Solver 而不依赖评分逻辑：

```javascript
class MockVerifier {
  async verify({ submission }) {
    const content = await readFile(join(submission, 'answer.txt'), 'utf8')
    const pass = content.includes('correct')
    
    return {
      status: pass ? 'resolved' : 'unresolved',
      reward: pass ? 1 : 0,
      feedback: pass ? 'Correct!' : 'Wrong answer'
    }
  }
}
```

### Mock Provider

用于测试 API 失败场景：

```javascript
class MockProvider {
  constructor({ failureRate = 0 }) {
    this.failureRate = failureRate
  }
  
  async chat({ messages }) {
    if (Math.random() < this.failureRate) {
      const error = new Error('API rate limit')
      error.code = 'rate_limit_exceeded'
      throw error
    }
    
    return { content: 'mock response' }
  }
}
```

## 调试技巧

### 保留临时目录

测试失败时保留临时目录用于检查：

```javascript
test('调试示例', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'debug-'))
  
  try {
    await runTest(tmpDir)
  } finally {
    // 失败时不清理
    if (process.env.DEBUG_KEEP_TMP) {
      console.log(`临时目录保留在: ${tmpDir}`)
    } else {
      await rm(tmpDir, { recursive: true, force: true })
    }
  }
})
```

**使用**：

```bash
DEBUG_KEEP_TMP=1 node --test controller/test/my-test.mjs
```

### 详细日志

启用详细日志查看内部执行流程：

```bash
DEBUG=harness:* node --test controller/test/my-test.mjs
```

### 单独运行失败测试

```bash
# 只运行匹配的测试
node --test --test-name-pattern="OmegaUse 离线验证" controller/test/
```

### 查看 Docker 容器日志

```bash
# 测试运行期间查看容器
docker ps -a

# 查看容器日志
docker logs <container-id>

# 进入容器调试
docker exec -it <container-id> sh
```

## 性能测试

### 基准测试

```javascript
test('OmegaUse Verifier 性能基准', async () => {
  const startTime = Date.now()
  
  await verifier.verify({ submission: testSubmission })
  
  const duration = Date.now() - startTime
  
  // 单题评分应在 5 秒内完成
  assert.ok(duration < 5000, `Verifier 耗时 ${duration}ms，超过 5000ms`)
})
```

### 并发测试

```javascript
test('Environment 并发运行 10 道题', async () => {
  const tasks = Array.from({ length: 10 }, (_, i) => ({
    instanceId: `task${i}`,
    seed: 42
  }))
  
  const startTime = Date.now()
  
  await Promise.all(
    tasks.map(task => env.runTrial(task))
  )
  
  const duration = Date.now() - startTime
  const avgTime = duration / tasks.length
  
  console.log(`平均每题耗时: ${avgTime}ms`)
})
```

## CI 集成

### GitHub Actions 示例

```yaml
# .github/workflows/test.yml
name: Test

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    
    steps:
      - uses: actions/checkout@v3
      
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
      
      - run: npm ci
      
      - run: npm run check
      
      - run: npm test
      
      - name: Upload coverage
        uses: codecov/codecov-action@v3
```

### Pre-commit Hook

```bash
# .git/hooks/pre-commit
#!/bin/sh

npm run check || exit 1
npm test -- --bail || exit 1
```

## 常见测试失败排查

### Docker 相关

**问题**：`Cannot connect to Docker daemon`

**原因**：Docker 未启动或权限不足

**解决**：

```bash
# 启动 Docker
sudo systemctl start docker

# 添加用户到 docker 组
sudo usermod -aG docker $USER
newgrp docker
```

### 环境变量

**问题**：测试跳过（`skip: true`）

**原因**：缺少必需的环境变量

**解决**：

```bash
# 检查测试需要的环境变量
grep -r "process.env" controller/test/*.test.mjs

# 设置环境变量
export RSI_OFFICEVAL_DATASET_ROOT="$PWD/../datasets/OmegaUse-OfficeVal-Dataset"
```

### 超时

**问题**：测试超时

**原因**：网络慢、资源不足、死锁

**解决**：

```bash
# 增加超时
TEST_TIMEOUT_MS=120000 node --test controller/test/slow-test.mjs

# 检查是否有死锁
ps aux | grep node
```

### 临时文件

**问题**：`ENOENT: no such file or directory`

**原因**：临时文件被提前清理

**解决**：

```javascript
// 确保在 try/finally 中清理
try {
  await test(tmpDir)
} finally {
  await rm(tmpDir, { recursive: true, force: true })
}
```

## 测试 Checklist

新增功能时的测试清单：

- [ ] 单元测试覆盖核心逻辑
- [ ] 集成测试验证组件协作
- [ ] E2E 测试覆盖完整流程
- [ ] 错误路径测试（网络失败、超时、非法输入）
- [ ] 边界条件测试（空输入、最大值、并发）
- [ ] 资源清理验证（临时文件、Docker 容器）
- [ ] 幂等性验证（多次运行结果一致）
- [ ] Resume 机制验证（中断后恢复）
- [ ] 隔离性验证（网络、文件系统、进程）
- [ ] 性能基准验证（不低于预期阈值）

## 参考资源

- [Node.js Test Runner 文档](https://nodejs.org/api/test.html)
- [Docker 测试最佳实践](https://docs.docker.com/develop/dev-best-practices/)
- [现有测试示例](../controller/test/)
