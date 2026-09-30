#!/bin/bash
# 安装 Git Hooks

set -e

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
HOOKS_DIR="$REPO_ROOT/.git/hooks"
SCRIPTS_DIR="$REPO_ROOT/scripts"

if [ ! -d "$HOOKS_DIR" ]; then
  echo "错误：未找到 .git/hooks 目录"
  echo "请在 Git 仓库根目录运行此脚本"
  exit 1
fi

echo "安装 Git Hooks..."

# 安装 pre-commit hook
if [ -f "$SCRIPTS_DIR/pre-commit" ]; then
  cp "$SCRIPTS_DIR/pre-commit" "$HOOKS_DIR/pre-commit"
  chmod +x "$HOOKS_DIR/pre-commit"
  echo "✅ pre-commit hook 已安装"
else
  echo "⚠️  未找到 scripts/pre-commit"
fi

echo ""
echo "Git Hooks 安装完成！"
echo ""
echo "提示："
echo "  - 每次提交前会自动运行语法检查和快速测试"
echo "  - 如需跳过检查，使用：git commit --no-verify"
echo "  - 完整测试请运行：npm test"
