#!/usr/bin/env bash
# Docker 资源限制验证脚本
#
# 用法：./scripts/validate-docker-resources.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "================================"
echo "Docker 资源限制验证"
echo "================================"
echo ""

# 检查 Docker 是否可用
if ! command -v docker &> /dev/null; then
    echo -e "${RED}✗ Docker 未安装或不在 PATH 中${NC}"
    exit 1
fi

if ! docker ps &> /dev/null; then
    echo -e "${RED}✗ Docker 守护进程未运行或无权限${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Docker 可用${NC}"
echo ""

# 拉取测试镜像
echo "拉取测试镜像..."
if ! docker pull alpine:latest &> /dev/null; then
    echo -e "${YELLOW}⚠ 无法拉取 alpine:latest，使用本地镜像${NC}"
fi
echo ""

PASSED=0
FAILED=0

# 测试函数
run_test() {
    local test_name=$1
    local test_cmd=$2

    echo -n "测试: $test_name ... "

    if eval "$test_cmd" &> /dev/null; then
        echo -e "${GREEN}✓ 通过${NC}"
        PASSED=$((PASSED + 1))
        return 0
    else
        echo -e "${RED}✗ 失败${NC}"
        FAILED=$((FAILED + 1))
        return 1
    fi
}

# CPU 限制测试
echo "──────────────────────────────"
echo "CPU 限制验证"
echo "──────────────────────────────"

run_test "CPU 限制基本功能" \
    "docker run --rm --cpus=0.5 alpine:latest sh -c 'echo test' | grep -q 'test'"

run_test "CPU 限制配置正确" \
    "docker run --name cpu-test --cpus=1.5 --rm -d alpine:latest sleep 5 && \
     docker inspect cpu-test --format '{{.HostConfig.NanoCpus}}' | grep -q '1500000000' && \
     docker stop cpu-test"

echo ""

# 内存限制测试
echo "──────────────────────────────"
echo "内存限制验证"
echo "──────────────────────────────"

run_test "内存限制基本功能" \
    "docker run --rm --memory=256m alpine:latest sh -c 'dd if=/dev/zero of=/tmp/test bs=1M count=64 2>/dev/null && echo ok' | grep -q 'ok'"

run_test "内存限制配置正确" \
    "docker run --name mem-test --memory=512m --rm -d alpine:latest sleep 5 && \
     docker inspect mem-test --format '{{.HostConfig.Memory}}' | grep -q '536870912' && \
     docker stop mem-test"

run_test "内存超限时 OOM" \
    "! docker run --rm --memory=128m alpine:latest sh -c 'dd if=/dev/zero of=/tmp/test bs=1M count=256 2>/dev/null'"

echo ""

# PIDs 限制测试
echo "──────────────────────────────"
echo "PIDs 限制验证"
echo "──────────────────────────────"

run_test "PIDs 限制基本功能" \
    "docker run --rm --pids-limit=50 alpine:latest sh -c 'for i in \$(seq 1 5); do (sleep 1 &); done && wait && echo ok' | grep -q 'ok'"

run_test "PIDs 超限时失败" \
    "! docker run --rm --pids-limit=10 alpine:latest sh -c 'for i in \$(seq 1 20); do (sleep 10 &); done 2>&1' | grep -q 'fork'"

echo ""

# 网络隔离测试
echo "──────────────────────────────"
echo "网络隔离验证"
echo "──────────────────────────────"

run_test "网络隔离 (none)" \
    "docker run --rm --network=none alpine:latest sh -c 'ping -c 1 -W 1 8.8.8.8 2>&1' | grep -q -E 'Network|unreachable|no-network|bad address'"

run_test "网络访问 (bridge)" \
    "docker run --rm --network=bridge alpine:latest sh -c 'echo network-test'"

run_test "网络模式配置正确" \
    "docker run --name net-test --network=none --rm -d alpine:latest sleep 5 && \
     docker inspect net-test --format '{{.HostConfig.NetworkMode}}' | grep -q 'none' && \
     docker stop net-test"

echo ""

# 综合测试
echo "──────────────────────────────"
echo "综合资源限制验证"
echo "──────────────────────────────"

run_test "多项资源限制同时生效" \
    "docker run --rm --cpus=1 --memory=256m --pids-limit=50 --network=none alpine:latest sh -c 'echo ok' | grep -q 'ok'"

run_test "HarnessEvoGym 典型配置" \
    "docker run --rm --cpus=2 --memory=2g --pids-limit=256 --network=bridge alpine:latest sh -c 'echo harness-ok' | grep -q 'harness-ok'"

echo ""

# 总结
echo "================================"
echo "测试总结"
echo "================================"
echo -e "通过: ${GREEN}$PASSED${NC}"
echo -e "失败: ${RED}$FAILED${NC}"
echo ""

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}✓ 所有 Docker 资源限制验证通过${NC}"
    exit 0
else
    echo -e "${RED}✗ 部分 Docker 资源限制验证失败${NC}"
    exit 1
fi
