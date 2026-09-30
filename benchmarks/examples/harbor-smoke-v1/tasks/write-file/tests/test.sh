#!/bin/bash
set -e

OUTPUT_FILE="/workspace/output.txt"
REWARD_FILE="/logs/verifier/reward.txt"

if [ ! -f "$OUTPUT_FILE" ]; then
  echo "0" > "$REWARD_FILE"
  echo "FAIL: output.txt 不存在"
  exit 0
fi

CONTENT=$(cat "$OUTPUT_FILE")

if [ "$CONTENT" = "Hello, Harbor!" ]; then
  echo "1" > "$REWARD_FILE"
  echo "PASS: 文件内容正确"
else
  echo "0" > "$REWARD_FILE"
  echo "FAIL: 期望 'Hello, Harbor!'，实际得到 '$CONTENT'"
fi
