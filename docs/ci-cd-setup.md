# CI/CD 流水线完善说明

## 新增 Workflow

### 1. `.github/workflows/ci.yml`（增强）

已有的基础 CI 流程，新增：

- **Docker 构建验证**：验证 model-gateway 和 msa-minimal-runtime 镜像可以成功构建
- **依赖安全审计**：运行 `npm audit --production --audit-level=high` 检查高危漏洞
- **脚本语法验证**：检查所有 Shell 和 Python 脚本语法正确性

### 2. `.github/workflows/docker-build.yml`（新增）

自动构建和推送 Docker 镜像到 GitHub Container Registry：

- **触发条件**：推送到 main 分支、打 tag、或手动触发
- **构建矩阵**：并行构建四个运行时镜像
  - model-gateway
  - msa-minimal-runtime
  - dsh-runtime
  - omegause-officeval
- **镜像命名**：`ghcr.io/<owner>/harness-evogym-<name>:<tag>`
- **缓存优化**：使用 GitHub Actions cache 加速构建

### 3. `.github/workflows/release.yml`（新增）

自动化版本发布流程：

- **触发条件**：推送 `v*` tag 或手动触发
- **自动生成 Changelog**：基于 Git 提交历史
- **创建 GitHub Release**：包含变更日志和 Docker 镜像清单
- **预发布识别**：自动标记 alpha/beta/rc 版本为 prerelease

## 验证步骤

所有 workflow YAML 语法已验证通过。

## 使用说明

### 日常开发

推送到 `lz-dev` 或 `main` 分支会触发：
- 代码语法检查
- 单元测试
- Python 评测器测试
- Docker 构建验证
- 依赖安全审计

### 发布新版本

1. 打 tag：`git tag v0.2.0 && git push origin v0.2.0`
2. 自动触发：
   - Docker 镜像构建和推送（带版本 tag）
   - GitHub Release 创建（包含 changelog）
3. 镜像可用地址：
   - `ghcr.io/<owner>/harness-evogym-model-gateway:v0.2.0`
   - `ghcr.io/<owner>/harness-evogym-msa-minimal-runtime:v0.2.0`
   - 等

### 手动触发

所有 workflow 都支持通过 GitHub Actions UI 手动触发（workflow_dispatch）。

## 下一步优化方向

- 添加代码覆盖率报告（可选）
- 集成性能回归测试（需要 benchmark 基准）
- 添加自动化的端到端测试（需要完整环境）
