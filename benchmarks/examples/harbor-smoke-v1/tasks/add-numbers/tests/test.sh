#!/bin/bash
set -e

RESULT_FILE="/workspace/result.txt"
REWARD_FILE="/logs/verifier/reward.txt"

if [ ! -f "$RESULT_FILE" ]; then
  echo "0" > "$REWARD_FILE"
  echo "FAIL: result.txt 不存在"
  exit 0
fi

RESULT=$(cat "$RESULT_FILE" | tr -d '[:space:]')

if [ "$RESULT" = "579" ]; then
  echo "1" > "$REWARD_FILE"
  echo "PASS: 123 + 456 = 579"
else
  echo "0" > "$REWARD_FILE"
  echo "FAIL: 期望 579，实际得到 $RESULT"
fi
