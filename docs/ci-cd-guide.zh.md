# CI/CD 配置说明

本仓库使用 GitHub Actions 做持续集成，并提供 Git Hooks 支持本地快速检查。

## Workflow 总览

| 文件                                 | 触发条件                                         | 作用                                                      |
| ------------------------------------ | ------------------------------------------------ | --------------------------------------------------------- |
| `.github/workflows/ci.yml`           | push 到 `lz-dev` / `main`，以及所有 Pull Request | 语法检查、离线测试、覆盖率采样、Docker 构建验证、依赖审计 |
| `.github/workflows/docker-build.yml` | push 到 `main`、推送 `v*` tag、手动触发          | 构建并推送四个运行时镜像到 GHCR                           |
| `.github/workflows/release.yml`      | 推送 `v*` tag、手动触发                          | 生成 Changelog 并创建 GitHub Release                      |

## ci.yml：离线测试

**触发条件**：push 到 `lz-dev` 或 `main`，以及创建 Pull Request。

**执行步骤**：

1. 检查源码与脚本语法（`npm run check`，含 `check:paths` 可移植路径检查）
2. 运行 Controller 与 Server 离线测试（`npm test`）
3. 运行独立评测器测试（`npm run test:eval`）
4. 生成测试覆盖率报告（对核心模块采样，避免重复执行完整套件）
5. 验证 Docker 构建配置（`model-gateway`、`msa-minimal-runtime`）
6. 检查依赖安全漏洞（`npm audit --production --audit-level=high`）
7. 验证关键脚本可执行（Shell 语法、Python 编译）

CI 不依赖外网、真实凭据或隐藏任务。需要 Docker、GPU 或真实数据集的端到端测试默认跳过，不会在 CI 中运行。

## docker-build.yml：镜像构建与推送

**触发条件**：push 到 `main`、推送 `v*` tag，或手动触发。

**构建矩阵**：并行构建四个运行时镜像。

- `model-gateway`
- `msa-minimal-runtime`
- `dsh-runtime`
- `omegause-officeval`

**镜像命名**：`ghcr.io/<owner>/harness-evogym-<name>:<tag>`

**缓存**：使用 GitHub Actions cache（`type=gha`）加速构建。Pull Request 上只构建不推送。

## release.yml：版本发布

**触发条件**：推送 `v*` tag，或手动触发。

**流程**：

1. 基于 Git 提交历史自动生成 Changelog（与上一个 tag 比较）
2. 写入 Release Notes，包含变更列表与四个镜像的地址
3. 创建 GitHub Release；`-alpha` / `-beta` / `-rc` 版本自动标记为 prerelease

## 本地 Git Hooks

**安装**：

```bash
./scripts/install-hooks.sh
```

**Pre-commit Hook**：每次 `git commit` 前自动运行源码语法检查和快速单元测试。

**跳过 Hook**（不推荐）：

```bash
git commit --no-verify
```

## 测试策略

**快速测试**（Pre-commit Hook，约 10 秒内）：覆盖 Updater 相关模块。

- `updater-runner.test.mjs`
- `updater-failure-tracker.test.mjs`
- `updater-run-error.test.mjs`
- `task-failure-tracker.test.mjs`
- `solver-failure.test.mjs`

**完整测试**（CI）：

```bash
npm test
npm run test:eval
```

**需要显式开启的慢速 E2E**（默认跳过）：

- `harbor-e2e-smoke.test.mjs`（`RSI_RUN_DOCKER_E2E=1`）
- `kernelbench-e2e-smoke.test.mjs`（`RSI_RUN_KERNELBENCH_DOCKER_E2E=1`，需要 GPU）
- `omegause-offline-e2e.test.mjs`（需要真实 OfficeVal 数据集）

## 测试覆盖率

**本地生成**：

```bash
node --test --experimental-test-coverage ./controller/test/*.test.mjs ./server/test/*.test.mjs
```

**CI 中**：对新增核心模块采样生成，并写入 GitHub Actions Summary。

## 开发流程

1. **本地开发**：`npm ci` → `./scripts/install-hooks.sh` → 开发 → 提交时自动跑快速检查
2. **提交前手动运行完整检查**：`npm run check`、`npm test`、`npm run test:eval`
3. **创建 PR**：CI 自动运行完整测试；失败时无法合并
4. **合并后**：主分支自动运行 CI，保持始终可用

## 常见问题

**Pre-commit Hook 太慢怎么办？**
临时跳过：`git commit --no-verify`，但 CI 仍会运行完整测试。

**CI 测试失败但本地通过？**
检查是否有未提交的文件，或环境差异（Node 版本、依赖版本）。本地残留的运行缓存（如 `__pycache__`）不会进入 Candidate 摘要，但其他未提交改动会影响结果。

**如何添加新的测试到 Pre-commit？**
编辑 `scripts/pre-commit`，在快速测试列表中添加新文件。

**如何更新 CI 配置？**
编辑 `.github/workflows/ci.yml`，提交后自动生效。

## 最佳实践

1. 提交前运行测试，避免把失败代码推上去
2. 小步提交，每个提交只做一件事
3. 写清提交信息：做了什么、为什么
4. 关注 CI 结果，及时修复失败项
5. 保持测试快速：慢速测试移出默认套件，用环境变量显式开启
