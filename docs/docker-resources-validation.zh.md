# Docker 资源限制验证指南

本文档提供 HarnessEvoGym RSI 的 Docker 资源限制验证方法和工具。

──────────────────────────────────────────

## 资源限制概述

HarnessEvoGym 通过 Docker 容器运行 Solver 和 Updater，使用资源限制确保：
- **隔离性**：单个任务不会耗尽系统资源
- **公平性**：所有 Candidates 在相同资源约束下评测
- **安全性**：防止恶意代码消耗过多资源

### 限制类型

| 资源类型 | 配置字段 | 典型值 | 作用 |
|---------|---------|--------|------|
| **CPU** | `cpus` | 1-4 | 限制 CPU 核心数 |
| **内存** | `memory` | 512m-4g | 限制最大内存使用 |
| **进程数** | `pids` | 128-512 | 限制最大进程/线程数 |
| **网络** | `network` | none/bridge | 控制网络访问 |
| **超时** | `timeoutSeconds` | 60-600 | 任务最大运行时间 |

──────────────────────────────────────────

## 配置示例

### Text Reasoning Environment

```yaml
# environments/text-reasoning-smoke.yml

docker:
  binary: docker
  network: bridge
  runAsCurrentUser: true
  resources:
    cpus: 2              # 2 个 CPU 核心
    memory: 2g           # 2 GB 内存
    pids: 256            # 最多 256 个进程
    timeoutSeconds: 300  # 5 分钟超时

modelGateway:
  resources:
    cpus: 1              # Model Gateway 使用更少资源
    memory: 512m
    pids: 128
```

### OmegaUse Environment

```yaml
# environments/omegause-officeval.yml

docker:
  resources:
    cpus: 4              # 更多 CPU（文档处理密集）
    memory: 4g           # 更多内存（大文件）
    pids: 512            # 更多进程（并发任务）
    timeoutSeconds: 600  # 更长超时（复杂任务）
```

──────────────────────────────────────────

## 验证方法

### 方法 1：自动化测试

运行资源限制测试套件：

```bash
cd controller
node --test test/docker-resources.test.mjs
```

测试覆盖：
- ✅ CPU 限制生效
- ✅ 内存限制生效（OOM 检测）
- ✅ PIDs 限制生效（fork 限制）
- ✅ 网络隔离生效
- ✅ 综合资源限制
- ✅ 配置合理性检查

### 方法 2：手动验证

**验证 CPU 限制**：

```bash
# 启动限制为 0.5 核的容器
docker run --rm --cpus=0.5 alpine:latest \
  sh -c 'for i in $(seq 1 1000000); do echo $i > /dev/null; done && echo done'

# 验证配置
docker run --name test-cpu --cpus=1.5 -d alpine:latest sleep 10
docker inspect test-cpu --format '{{.HostConfig.NanoCpus}}'
# 应该输出: 1500000000 (1.5 * 10^9)
docker stop test-cpu
```

**验证内存限制**：

```bash
# 尝试分配超过限制的内存（应该失败）
docker run --rm --memory=128m alpine:latest \
  sh -c 'dd if=/dev/zero of=/tmp/test bs=1M count=256 2>&1 || echo oom'

# 在限制内分配内存（应该成功）
docker run --rm --memory=256m alpine:latest \
  sh -c 'dd if=/dev/zero of=/tmp/test bs=1M count=64 2>&1 && echo ok'

# 验证配置
docker run --name test-mem --memory=512m -d alpine:latest sleep 10
docker inspect test-mem --format '{{.HostConfig.Memory}}'
# 应该输出: 536870912 (512 * 1024 * 1024)
docker stop test-mem
```

**验证 PIDs 限制**：

```bash
# 尝试创建超过限制的进程（应该失败）
docker run --rm --pids-limit=10 alpine:latest \
  sh -c 'for i in $(seq 1 20); do (sleep 10 &); done 2>&1'

# 在限制内创建进程（应该成功）
docker run --rm --pids-limit=50 alpine:latest \
  sh -c 'for i in $(seq 1 5); do (sleep 1 &); done && wait && echo ok'
```

**验证网络隔离**：

```bash
# none 模式：无网络访问
docker run --rm --network=none alpine:latest \
  sh -c 'ping -c 1 -W 1 8.8.8.8 2>&1 || echo no-network'

# bridge 模式：有网络访问
docker run --rm --network=bridge alpine:latest \
  sh -c 'ping -c 1 -W 2 8.8.8.8 && echo network-ok || echo network-fail'

# 验证配置
docker run --name test-net --network=none -d alpine:latest sleep 10
docker inspect test-net --format '{{.HostConfig.NetworkMode}}'
# 应该输出: none
docker stop test-net
```

### 方法 3：实际 Evolution 验证

在真实 Evolution 中观察资源使用：

```bash
# 启动 Evolution
node controller/src/cli.mjs run experiments/reasoning-msa-smoke-single.json

# 在另一个终端监控资源使用
watch -n 1 'docker stats --no-stream --format "table {{.Container}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.PIDs}}"'
```

观察：
- CPU 使用率不应超过配置值（如 cpus=2，使用率 <= 200%）
- 内存使用量不应超过配置值
- PIDs 数量不应超过配置值

──────────────────────────────────────────

## 常见问题排查

### Q1: 容器因 OOM 被 killed

**现象**：
```
Error: Container killed due to OOM
```

**原因**：内存限制过低，任务需要更多内存

**解决**：
1. 检查任务的实际内存需求
2. 适当增加 `memory` 配置
3. 或者优化任务内存使用

示例：
```yaml
resources:
  memory: 4g  # 从 2g 增加到 4g
```

### Q2: 容器因 PIDs 限制失败

**现象**：
```
fork: retry: Resource temporarily unavailable
```

**原因**：任务创建的进程/线程数超过限制

**解决**：
1. 检查任务是否需要大量并发
2. 增加 `pids` 配置
3. 或者优化任务减少进程数

示例：
```yaml
resources:
  pids: 512  # 从 256 增加到 512
```

### Q3: 任务运行缓慢

**现象**：任务完成时间远超预期

**原因**：CPU 限制过低

**解决**：
1. 增加 `cpus` 配置
2. 使用 `docker stats` 观察 CPU 使用率
3. 如果 CPU 使用率接近限制，说明需要更多 CPU

示例：
```yaml
resources:
  cpus: 4  # 从 2 增加到 4
```

### Q4: 网络访问失败

**现象**：
```
Network is unreachable
```

**原因**：`network: none` 禁止网络访问

**解决**：
1. 如果任务需要访问外部 API，使用 `network: bridge`
2. 如果需要完全隔离，确保任务不依赖网络

示例：
```yaml
docker:
  network: bridge  # 从 none 改为 bridge
```

### Q5: 超时失败

**现象**：
```
Container timed out after 300 seconds
```

**原因**：任务运行时间超过 `timeoutSeconds`

**解决**：
1. 增加 `timeoutSeconds` 配置
2. 或者优化任务执行效率

示例：
```yaml
resources:
  timeoutSeconds: 600  # 从 300 增加到 600
```

──────────────────────────────────────────

## 资源限制最佳实践

### 1. 根据任务类型调整

**轻量级推理任务**（Text Reasoning）：
```yaml
resources:
  cpus: 2
  memory: 2g
  pids: 256
  timeoutSeconds: 300
```

**文档处理任务**（OmegaUse）：
```yaml
resources:
  cpus: 4          # 更多 CPU
  memory: 4g       # 更多内存
  pids: 512        # 更多进程
  timeoutSeconds: 600  # 更长超时
```

**代码生成任务**（Harbor）：
```yaml
resources:
  cpus: 2
  memory: 3g       # 中等内存
  pids: 256
  timeoutSeconds: 600  # 代码生成可能较慢
```

### 2. 为 Model Gateway 预留资源

Model Gateway 应该使用比主容器更少的资源：

```yaml
# 主容器
docker:
  resources:
    cpus: 4
    memory: 4g
    pids: 512

# Model Gateway（约为主容器的 1/4）
modelGateway:
  resources:
    cpus: 1
    memory: 512m
    pids: 128
```

### 3. 设置合理的超时

**超时建议**：
- 简单任务：60-300 秒
- 中等任务：300-600 秒
- 复杂任务：600-1800 秒
- 最大不超过 3600 秒（1 小时）

过短的超时可能导致误杀正常任务，过长的超时可能导致资源浪费。

### 4. 使用网络隔离

**何时使用 `network: none`**：
- 任务不需要访问外部 API
- 需要完全隔离（安全考虑）
- 基准测试（避免网络波动）

**何时使用 `network: bridge`**：
- 任务需要访问 Model Gateway
- 需要访问外部 API（如搜索、数据库）
- 需要下载资源

### 5. 监控资源使用

在 Evolution 运行期间使用 `docker stats` 监控：

```bash
# 持续监控
docker stats

# 单次快照
docker stats --no-stream

# 自定义格式
docker stats --format "table {{.Container}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.PIDs}}"
```

观察指标：
- CPU%：应该 < (cpus * 100%)
- MEM USAGE：应该 < memory 配置
- PIDS：应该 < pids 配置

──────────────────────────────────────────

## 配置模板

### 最小配置（Smoke Test）

```yaml
docker:
  resources:
    cpus: 1
    memory: 512m
    pids: 128
    timeoutSeconds: 60
```

### 标准配置（Production）

```yaml
docker:
  resources:
    cpus: 2
    memory: 2g
    pids: 256
    timeoutSeconds: 300
```

### 高性能配置（Large Tasks）

```yaml
docker:
  resources:
    cpus: 4
    memory: 8g
    pids: 512
    timeoutSeconds: 600
```

──────────────────────────────────────────

## 验收检查清单

在部署新环境配置前，完成以下验收：

- [ ] CPU 限制在手动测试中生效
- [ ] 内存限制在手动测试中生效（验证 OOM）
- [ ] PIDs 限制在手动测试中生效（验证 fork 失败）
- [ ] 网络隔离在手动测试中生效
- [ ] 配置值在合理范围内（cpus: 1-8, memory: 512m-16g, pids: 64-1024）
- [ ] Model Gateway 资源 <= 主容器资源
- [ ] 超时时间合理（60-3600 秒）
- [ ] 实际 Evolution 运行正常
- [ ] `docker stats` 显示资源使用在限制内
- [ ] 无 OOM killed、PIDs 限制或超时错误

──────────────────────────────────────────

**版本**：v1.0  
**更新时间**：2025-01-29
