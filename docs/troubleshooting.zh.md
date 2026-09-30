# 常见问题排查

本文档收集 HarnessEvoGym RSI 开发和运行中的常见问题及解决方法。

## 安装与环境

### Node.js 版本不匹配

**现象**：

```
Error: The engine "node" is incompatible with this module.
Expected version ">=20.0.0". Got "18.x.x"
```

**原因**：项目需要 Node.js 20+

**解决**：

```bash
# 使用 nvm 安装
nvm install 20
nvm use 20

# 或直接从 nodejs.org 下载
```

### npm install 失败

**现象**：

```
npm ERR! code EACCES
npm ERR! syscall mkdir
npm ERR! path /usr/local/lib/node_modules
```

**原因**：权限不足

**解决**：

```bash
# 方法 1：使用 npm 推荐的目录
mkdir ~/.npm-global
npm config set prefix '~/.npm-global'
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc
source ~/.bashrc

# 方法 2：使用 nvm（推荐）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
```

## Docker 相关

### Docker daemon 连接失败

**现象**：

```
Error: Cannot connect to the Docker daemon at unix:///var/run/docker.sock
```

**原因**：Docker 未启动或当前用户无权限

**解决**：

```bash
# 启动 Docker
sudo systemctl start docker

# 添加当前用户到 docker 组
sudo usermod -aG docker $USER
newgrp docker

# 验证
docker ps
```

### Docker 镜像拉取失败

**现象**：

```
Error: manifest for harness-rsi/omegause-officeval:v1 not found
```

**原因**：镜像未构建或 registry 不可用

**解决**：

```bash
# 构建本地镜像
cd docker/omegause-officeval
docker build -t harness-rsi/omegause-officeval:v1 .

# 或从 registry 拉取
docker pull <registry>/harness-rsi/omegause-officeval:v1
docker tag <registry>/harness-rsi/omegause-officeval:v1 harness-rsi/omegause-officeval:v1
```

### Docker 容器网络问题

**现象**：

```
Error: dial tcp: lookup model-gateway: no such host
```

**原因**：容器网络配置错误

**解决**：

```bash
# 检查网络模式
docker inspect <container-id> | grep NetworkMode

# network=none 模式下无法联网（这是正确的隔离行为）
# 如果需要网络，改用 network=bridge
```

### Docker cp --chown 不支持

**现象**：

```
Error: unknown flag: --chown
```

**原因**：旧版本 Docker 不支持 `--chown` 参数

**解决**：已在 P0-6 修复，使用 `-a` + 单独 `chown` 命令

```javascript
// controller/src/docker.mjs
async copyFrom(container, source, destination, { owner = null } = {}) {
  const args = ['cp', '-a']  // 不使用 --chown
  args.push(`${container}:${source}`, destination)
  await runProcess(this.binary, args)
  
  if (owner !== null) {
    await runProcess('chown', ['-R', owner, destination])
  }
}
```

## 测试相关

### 测试全部跳过

**现象**：

```
# tests 0
# skipped 10
```

**原因**：缺少必需的环境变量

**解决**：

```bash
# 检查测试需要的环境变量
grep -r "skip:" controller/test/*.test.mjs

# OmegaUse 测试需要
export RSI_OFFICEVAL_DATASET_ROOT=/path/to/dataset
export RSI_OFFICEVAL_EVALUATOR_ROOT=/path/to/evaluator

# Harbor 测试需要
export RSI_HARBOR_DATASET_ROOT=/path/to/harbor-dataset
```

### 测试超时

**现象**：

```
Error: Test timeout (exceeded 60000ms)
```

**原因**：网络慢、Docker 拉取镜像慢、资源不足

**解决**：

```bash
# 增加超时时间
TEST_TIMEOUT_MS=300000 node --test controller/test/slow-test.mjs

# 预先拉取镜像
docker pull harness-rsi/omegause-officeval:v1

# 检查系统资源
free -h
df -h
```

### 临时文件清理失败

**现象**：

```
Error: EBUSY: resource busy or locked
```

**原因**：文件正在被占用（通常是 Docker 容器挂载）

**解决**：

```bash
# 停止所有相关容器
docker ps -a | grep harness-rsi | awk '{print $1}' | xargs docker rm -f

# 清理临时目录
rm -rf /tmp/omegause-*
```

## 运行时错误

### Solver 失败但未重试

**现象**：单次 API 429 导致题目失败，但没有自动重试

**原因**：Environment 未启用 infrastructureRetries

**解决**：

```javascript
// 确保 runCandidatePartition 传入重试参数
await environment.runCandidatePartition({
  candidateId,
  partition: 'feedback',
  infrastructureRetries: 3,  // 添加此行
  // ...
})
```

### Verifier 找不到交付物

**现象**：

```
error=文件无法打开: Package not found at '/submission/deliverable.pptx'
```

**原因**：

1. Solver 未生成交付物
2. 交付物路径错误
3. Docker 挂载问题

**解决**：

```bash
# 检查 Solver 输出
cat .rsi/runs/<run-id>/trials/<execution-id>/<candidate-id>/<partition>/<instance-id>/solver.log

# 检查工作区内容
ls -la .rsi/runs/<run-id>/trials/<execution-id>/<candidate-id>/<partition>/<instance-id>/trial-1-seed-42/

# 检查 Docker 挂载
docker inspect <container-id> | jq '.[0].Mounts'
```

### Checkpoint 不一致

**现象**：

```
Error: Trial Checkpoint 与 Task/Seed 不一致
```

**原因**：

1. 手动修改了 checkpoint 文件
2. 并发写入冲突
3. Candidate Digest 变化

**解决**：

```bash
# 删除损坏的 checkpoint
rm -rf .rsi/runs/<run-id>/trials/<execution-id>/checkpoints/

# 重新运行
npm run rsi -- experiment run --config experiments/example.json
```

## Evolution 运行问题

### Updater 无法连接 Model Gateway

**现象**：

```
Error: connect ECONNREFUSED 127.0.0.1:8080
```

**原因**：Model Gateway 未启动或端口被占用

**解决**：

```bash
# 检查 Gateway 是否运行
docker ps | grep model-gateway

# 检查端口占用
lsof -i :8080

# 查看 Gateway 日志
docker logs <gateway-container-id>
```

### MutationLease 越权修改

**现象**：

```
Error: 文件 profile.json 不在 MutationLease 允许的写入路径
```

**原因**：Updater 尝试修改 Lease 外的文件

**解决**：这是正确的安全检查。检查 Updater 逻辑：

```javascript
// 确保 Updater 只修改 Region 内的文件
const lease = {
  writablePaths: ['skills/*.md'],
  readonlyPaths: ['profile.json', 'tools.py']
}

// Updater 不应修改 readonlyPaths
```

### Generation 连续失败

**现象**：多个 Generation 连续失败，Evolution 停止

**原因**：

1. Updater 生成的代码有语法错误
2. Semantic Validator 拒绝
3. 所有题目都超时

**解决**：

```bash
# 查看 Updater 日志
cat .rsi/runs/<run-id>/generations/g002/updater.log

# 查看 Mutation Report
cat .rsi/runs/<run-id>/generations/g002/mutation-report.json

# 查看 Validator 输出
cat .rsi/runs/<run-id>/generations/g002/validation.log
```

## 性能问题

### Evolution 运行很慢

**现象**：单个 Generation 需要几小时

**原因**：

1. 题目并发度低
2. Docker 镜像每次重新拉取
3. 网络慢

**优化**：

```yaml
# environments/omegause-officeval.yml
spec:
  task:
    maximumConcurrentTrials: 4  # 增加并发度（根据机器资源）
  
  docker:
    resources:
      cpus: 2  # 降低单容器资源，提高并发
      memory: 4g
```

```bash
# 预先拉取镜像
docker pull harness-rsi/omegause-officeval:v1
docker pull harness-rsi/model-gateway:v1
```

### 磁盘空间不足

**现象**：

```
Error: ENOSPC: no space left on device
```

**原因**：Trial 产物、Docker 镜像、临时文件占用空间

**解决**：

```bash
# 清理旧 Run
rm -rf .rsi/runs/old-run-*

# 清理 Docker
docker system prune -a

# 清理临时文件
rm -rf /tmp/omegause-*
rm -rf /tmp/harbor-*
```

## 数据集问题

### OmegaUse 数据集找不到

**现象**：

```
Error: OmegaUse Dataset Root 不存在
```

**原因**：环境变量未设置或路径错误

**解决**：

```bash
# 检查路径
ls -la $RSI_OFFICEVAL_DATASET_ROOT

# 设置正确路径
export RSI_OFFICEVAL_DATASET_ROOT=/data/workspace/.../OmegaUse-OfficeVal-Dataset
export RSI_OFFICEVAL_EVALUATOR_ROOT=/data/workspace/.../OmegaUse-OfficeVal

# 添加到 ~/.bashrc
echo 'export RSI_OFFICEVAL_DATASET_ROOT=...' >> ~/.bashrc
```

### Manifest 摘要不一致

**现象**：

```
Error: OmegaUse Source Manifest 摘要与冻结配置不一致
actual=abc123...
environment=def456...
```

**原因**：数据集版本不匹配

**解决**：

```bash
# 检查 Git Revision
cd $RSI_OFFICEVAL_DATASET_ROOT
git rev-parse HEAD
# 应该是: cd6ba6d8fb83b3fb551e24eebc20e1fb0bd154a5

cd $RSI_OFFICEVAL_EVALUATOR_ROOT
git rev-parse HEAD
# 应该是: ffbeecb8752447c8e40b594a0eeb1db7236ecb36

# 切换到正确版本
git checkout cd6ba6d8fb83b3fb551e24eebc20e1fb0bd154a5
```

## 协议与配置

### Benchmark 配置无效

**现象**：

```
Error: Benchmark 配置校验失败
spec.source.revision 必须固定到不可变版本
```

**原因**：使用了浮动版本（main/master/HEAD）

**解决**：

```json
{
  "spec": {
    "source": {
      "revision": "8bf749b53988822a90520eba4761c6c311e17dd0e13bd78658b261a921128291"
      // 不要使用 "revision": "main"
    }
  }
}
```

### Partition 实例重复

**现象**：

```
Error: spec.partitions.selection.instanceIds[2] 跨 Partition 重复
```

**原因**：同一题目出现在多个 partition

**解决**：

```json
{
  "spec": {
    "partitions": {
      "feedback": {
        "instanceIds": ["task001", "task002"]
      },
      "selection": {
        "instanceIds": ["task003", "task004"]  // 不能包含 task001
      }
    }
  }
}
```

### API Version 不匹配

**现象**：

```
Error: apiVersion 必须是 harness-rsi/v1alpha1
```

**原因**：配置文件使用了旧版本格式

**解决**：

```yaml
# 所有配置文件开头
apiVersion: harness-rsi/v1alpha1
kind: Benchmark  # 或 EnvironmentAdapter, EvolutionRecipe 等
```

## 日志与调试

### 找不到日志文件

**问题**：不知道日志在哪里

**解决**：

```bash
# Run 总目录
ls -la .rsi/runs/

# Solver 日志
.rsi/runs/<run-id>/trials/<execution-id>/<candidate-id>/<partition>/<instance-id>/solver.log

# Updater 日志
.rsi/runs/<run-id>/generations/<generation>/updater.log

# Verifier 输出（在 Result JSONL 的 feedback 字段）
cat .rsi/runs/<run-id>/trials/<execution-id>/feedback-results.jsonl | jq '.feedback'
```

### 启用调试日志

**解决**：

```bash
# 启用所有调试日志
DEBUG=* node --test controller/test/my-test.mjs

# 只启用特定模块
DEBUG=harness:docker,harness:verifier npm test
```

## 紧急修复

### 强制停止所有 Docker 容器

```bash
docker ps -aq | xargs docker stop
docker ps -aq | xargs docker rm
```

### 清理所有临时文件

```bash
rm -rf /tmp/omegause-*
rm -rf /tmp/harbor-*
rm -rf /tmp/text-reasoning-*
```

### 重置 Run 状态

```bash
# 删除损坏的 Run
rm -rf .rsi/runs/<run-id>

# 重新运行
npm run rsi -- experiment run --config experiments/example.json
```

## 获取帮助

如果以上方法都无法解决问题：

1. **查看完整错误栈**：

```bash
node --test controller/test/failing-test.mjs 2>&1 | tee error.log
```

2. **提交 Issue**，包含：
   - 完整错误信息
   - 运行环境（OS、Node 版本、Docker 版本）
   - 最小可复现步骤
   - 相关日志文件

3. **参考现有 Issue**：

```bash
# 搜索类似问题
gh issue list --search "Error: Cannot connect to Docker"
```

4. **查阅文档**：
   - [贡献者快速入门](contributor-quick-start.zh.md)
   - [测试指南](testing-guide.zh.md)
   - [完整贡献指南](../CONTRIBUTING.md)
