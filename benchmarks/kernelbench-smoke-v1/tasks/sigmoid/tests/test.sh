#!/usr/bin/env bash
set -euo pipefail
mkdir -p /logs/verifier
python /tests/evaluate.py /workspace/model_new.py
