#!/bin/bash
# 快速验证所有示例配置的语法

set -e

echo "🔍 验证示例实验配置..."

EXPERIMENTS_DIR="$(dirname "$0")"
FAILED=0
TOTAL=0

# 验证配置文件的基本结构
validate_config() {
  local file="$1"
  local basename=$(basename "$file")

  TOTAL=$((TOTAL + 1))

  # 检查 JSON 语法
  if ! jq empty "$file" > /dev/null 2>&1; then
    echo "  ❌ $basename - JSON 语法错误"
    FAILED=$((FAILED + 1))
    return 1
  fi

  # 检查必需字段
  if ! jq -e '.apiVersion' "$file" > /dev/null 2>&1; then
    echo "  ❌ $basename - 缺少 apiVersion"
    FAILED=$((FAILED + 1))
    return 1
  fi

  if ! jq -e '.kind' "$file" > /dev/null 2>&1; then
    echo "  ❌ $basename - 缺少 kind"
    FAILED=$((FAILED + 1))
    return 1
  fi

  if ! jq -e '.metadata.id' "$file" > /dev/null 2>&1; then
    echo "  ❌ $basename - 缺少 metadata.id"
    FAILED=$((FAILED + 1))
    return 1
  fi

  echo "  ✅ $basename"
  return 0
}

# 验证所有 JSON 配置文件
for config in "$EXPERIMENTS_DIR"/*.json; do
  if [ -f "$config" ]; then
    validate_config "$config"
  fi
done

echo ""
if [ $FAILED -eq 0 ]; then
  echo "✅ 所有 $TOTAL 个配置文件验证通过"
  exit 0
else
  echo "❌ $FAILED/$TOTAL 个配置文件验证失败"
  exit 1
fi
