# CI/CD 配置说明

本项目使用 GitHub Actions 进行持续集成，并提供 Git Hooks 支持本地快速检查。

## GitHub Actions CI

配置文件：`.github/workflows/ci.yml`

**触发条件**：
- Push 到 `lz-dev` 或 `main` 分支
- 创建 Pull Request

**CI 流程**：

1. **离线测试任务**（offline-tests）
   - 语法检查（npm run check）
   - Controller 和 Server 测试（npm test）
   - Evaluator 测试（npm run test:eval）
   - 测试覆盖率报告
   - Docker 镜像构建验证
   - 安全漏洞扫描（npm audit）
   - 脚本可执行性验证

2. **代码质量检查**（lint）
   - ESLint 检查（如果配置）
   - 代码格式检查（Prettier，如果安装）

**查看 CI 结果**：
- GitHub Actions 页面查看详细日志
- PR 页面查看测试状态
- 失败时会阻止合并

## 本地 Git Hooks

**安装 Hooks**：
```bash
./scripts/install-hooks.sh
```

**Pre-commit Hook**：
每次 `git commit` 前自动运行：
1. 源代码语法检查（npm run check）
2. 快速单元测试（跳过慢速 E2E 测试）

**跳过 Hook**（不推荐）：
```bash
git commit --no-verify
```

## 测试策略

**快速测试**（Pre-commit Hook，< 10秒）：
- updater-runner.test.mjs
- updater-failure-tracker.test.mjs
- updater-run-error.test.mjs
- task-failure-tracker.test.mjs
- solver-failure.test.mjs

**完整测试**（CI，< 5分钟）：
```bash
npm test
npm run test:eval
```

**包含慢速 E2E 测试**：
- harbor-e2e-smoke.test.mjs
- omegause-offline-e2e.test.mjs

## 测试覆盖率

**生成覆盖率报告**（Node.js 20+）：
```bash
node --test --experimental-test-coverage ./controller/test/*.test.mjs ./server/test/*.test.mjs
```

**CI 自动生成**：
- 每次 CI 运行自动生成覆盖率报告
- 显示在 GitHub Actions Summary 中

## 开发流程

1. **本地开发**
   ```bash
   # 安装依赖
   npm ci
   
   # 安装 Git Hooks
   ./scripts/install-hooks.sh
   
   # 开发代码
   # ...
   
   # 提交前自动运行快速检查
   git commit -m "feat: 新功能"
   ```

2. **提交前手动运行完整测试**
   ```bash
   npm run check  # 语法检查
   npm test       # 所有测试
   npm run test:eval  # Python 测试
   ```

3. **创建 PR**
   - CI 自动运行完整测试套件
   - 测试失败时 PR 无法合并
   - 查看 CI 日志定位问题

4. **合并后**
   - 主分支自动运行 CI
   - 确保主分支始终可用

## 常见问题

**Q: Pre-commit Hook 太慢怎么办？**  
A: 可以临时跳过：`git commit --no-verify`，但 CI 仍会运行完整测试。

**Q: CI 测试失败但本地通过？**  
A: 检查是否有未提交的文件，或环境差异（Node 版本、依赖版本）。

**Q: 如何添加新的测试到 Pre-commit？**  
A: 编辑 `scripts/pre-commit`，在快速测试列表中添加新文件。

**Q: 如何更新 CI 配置？**  
A: 编辑 `.github/workflows/ci.yml`，提交后自动生效。

## 最佳实践

1. **提交前运行测试**：避免提交失败代码
2. **小步提交**：每个提交只做一件事
3. **清晰的提交信息**：描述做了什么和为什么
4. **关注 CI 结果**：及时修复失败的测试
5. **保持测试快速**：慢速测试移到 CI 或单独运行
