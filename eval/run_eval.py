"""
独立泛化性评测脚本 — 绕开 sealed-final 框架，直接对 6 个候选 × 8 道 final 题评测。

唯一改动：用本目录的 model.py（加了断流/502/524 指数退避重试）临时替换每个候选
workspace 里的 model.py，评测结束后原样恢复。agent.py / run.py / tools.py / profiles /
skills 完全不动。

用法：
  export RSI_PROVIDER_API_KEY="sk-..."
  export RSI_PROVIDER_BASE_URL="https://api.zcloudapi.com/v1"
  export RSI_OFFICEVAL_DATASET_ROOT="/path/to/OmegaUse-OfficeVal-Dataset"
  export RSI_OFFICEVAL_EVALUATOR_ROOT="/path/to/OmegaUse-OfficeVal"
  python3 eval/run_eval.py [--modes h0 single ...] [--out eval/results]
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

# ── 路径常量 ─────────────────────────────────────────────────────────────────

EVAL_DIR    = Path(__file__).resolve().parent
REPO_ROOT   = EVAL_DIR.parent
# 016 worktree 里的冻结 population 数据（绝对路径）
_SIXTEEN_ROOT = Path("/data/workspace/liuzhou/projs/01-code-apps/项目-Deepseek-Harness-RSI/002-Code/.WorkTrees/016-fix-solver-failure-feedback")
_SIXTEEN    = _SIXTEEN_ROOT / ".rsi/runs/populations"
ROBUST_MODEL = EVAL_DIR / "model.py"
RUN_VERIFIER = _SIXTEEN_ROOT / "docker/omegause-officeval/run-verifier.py"
SOLVER_IMAGE = "harness-rsi/omegause-officeval:v1"

FINAL_TASK_IDS = [
    "officeval_011", "officeval_026", "officeval_033", "officeval_051",
    "officeval_070", "officeval_088", "officeval_089", "officeval_097",
]

# (population_dir_suffix, branch, candidate_id)
CANDIDATES: dict[str, tuple[str, str, str]] = {
    "h0":          ("single",      "branch-001", "h0"),
    "single":      ("single",      "branch-001", "g016-l3"),
    "independent": ("independent", "branch-002", "g008-l3"),
    "mutualism":   ("mutualism",   "branch-001", "g008-l3"),
    "competition": ("competition", "branch-002", "g005-l3"),
    "combined":    ("combined",    "branch-002", "g002-l3"),
}
_POP_PREFIX = "cowork-main16-ff-train8-test8-terra-xhigh-20260907-v1-"

# ── 环境变量 ─────────────────────────────────────────────────────────────────

def _require(var: str) -> str:
    v = os.environ.get(var, "").strip()
    if not v:
        raise SystemExit(f"ERROR: environment variable {var} is not set")
    return v


# ── workspace 路径 ───────────────────────────────────────────────────────────

def workspace_of(mode: str) -> Path:
    pop_suffix, branch, cand_id = CANDIDATES[mode]
    return _SIXTEEN / f"{_POP_PREFIX}{pop_suffix}" / "branches" / branch / "run" / "candidates" / cand_id / "workspace"


# ── 单题评测 ─────────────────────────────────────────────────────────────────

def run_one_task(mode: str, task_id: str, out_dir: Path) -> dict:
    """
    在 Docker 容器里运行一道题，返回:
      {"task": str, "reward": float, "error": str|None}
    在调用前把 workspace/model.py 换成带重试版本，调用后恢复。
    """
    ws = workspace_of(mode)
    orig   = ws / "model.py"
    backup = ws / "model.py.__eval_backup__"
    task_out = out_dir / mode / task_id
    task_out.mkdir(parents=True, exist_ok=True)
    answer_file = task_out / "answer.txt"

    # 定位任务数据目录
    ds_root = Path(_require("RSI_OFFICEVAL_DATASET_ROOT"))
    task_dir = ds_root / "task_files" / task_id
    if not task_dir.is_dir():
        task_dir = ds_root / task_id
    if not task_dir.is_dir():
        return {"task": task_id, "reward": 0.0, "error": f"task dir not found: {task_id}"}

    # 读取任务文本
    task_json_path = ds_root / "tasks" / f"{task_id}.json"
    if not task_json_path.exists():
        task_json_path = next(task_dir.glob("task*.json"), None)
    if task_json_path is None or not task_json_path.exists():
        # 从 tasks_and_rubrics JSON 里读
        tar = ds_root / "tasks_and_rubrics_en.json"
        if tar.exists():
            for rec in json.loads(tar.read_text()):
                if rec.get("id") == task_id or rec.get("id") == task_id.removeprefix("officeval_"):
                    task_text = rec.get("task") or rec.get("instruction", "")
                    break
            else:
                return {"task": task_id, "reward": 0.0, "error": "task text not found"}
        else:
            return {"task": task_id, "reward": 0.0, "error": "no task source found"}
    else:
        rec = json.loads(task_json_path.read_text())
        task_text = rec.get("task") or rec.get("instruction") or json.dumps(rec)

    api_key  = _require("RSI_PROVIDER_API_KEY")
    base_url = _require("RSI_PROVIDER_BASE_URL").rstrip("/")

    # Docker requires absolute paths for bind mounts
    ws_abs       = ws.resolve()
    task_dir_abs = task_dir.resolve()
    task_out_abs = task_out.resolve()
    task_out_abs.mkdir(parents=True, exist_ok=True)
    shutil.copy2(orig, backup)
    shutil.copy2(ROBUST_MODEL, orig)

    container = f"eval-{mode}-{task_id}-{uuid.uuid4().hex[:8]}"
    try:
        cmd = [
            "docker", "run", "--rm",
            "--name", container,
            "--network", "bridge",
            "--cpus", "4", "--memory", "8g", "--pids-limit", "512",
            # candidate workspace (ro) + task files (rw, agent writes here) + output
            "-v", f"{ws_abs}:/candidate:ro",
            "-v", f"{task_dir_abs}:/workspace",
            "-v", f"{task_out_abs}:/output",
            # solver env
            "-e", f"RSI_MODEL_GATEWAY_BASE_URL={base_url}",
            "-e", f"RSI_MODEL_GATEWAY_DUMMY_KEY={api_key}",
            "-e", "RSI_MODEL_GATEWAY_MODEL=gpt-5.6-terra",
            "-e", "RSI_MODEL_GATEWAY_MAX_TOKENS=8192",
            "-e", "RSI_SOLVER_MAX_STEPS=12",
            SOLVER_IMAGE,
            "python3", "/candidate/run.py",
            "--task", task_text,
            "--answer", "/output/answer.txt",
            "--trace",  "/output/agent.jsonl",
            "--profile", "cowork",
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
        if result.returncode != 0:
            snippet = (result.stderr or result.stdout or "")[:500]
            return {"task": task_id, "reward": 0.0, "error": f"exit {result.returncode}: {snippet}"}
        if not answer_file.exists():
            return {"task": task_id, "reward": 0.0, "error": "answer.txt not produced"}

        reward, err = _score(task_id, task_out, task_dir)
        return {"task": task_id, "reward": reward, "error": err}

    except subprocess.TimeoutExpired:
        subprocess.run(["docker", "kill", container], capture_output=True)
        return {"task": task_id, "reward": 0.0, "error": "timeout 3600s"}
    except Exception as exc:
        return {"task": task_id, "reward": 0.0, "error": str(exc)}
    finally:
        if backup.exists():
            shutil.move(str(backup), str(orig))


def _score(task_id: str, submission_dir: Path, task_dir: Path) -> tuple[float, str | None]:
    """Run the per-task verifier and return (reward 0-1, error|None)."""
    ev_root = Path(_require("RSI_OFFICEVAL_EVALUATOR_ROOT"))
    verifier = ev_root / "verifiers" / f"{task_id}_verifier.py"
    if not verifier.exists():
        return 0.0, f"verifier not found: {verifier}"

    result_file = submission_dir / "verifier_result.json"
    result_file.unlink(missing_ok=True)

    cmd = [
        sys.executable, str(RUN_VERIFIER),
        "--verifier",    str(verifier),
        "--submission",  str(submission_dir),
        "--output",      str(result_file),
        "--expected-id", task_id,
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if proc.returncode != 0:
            return 0.0, f"verifier failed: {(proc.stderr or proc.stdout)[:300]}"
        r = json.loads(result_file.read_text())
        max_s = r.get("max_score") or 1
        return float(r.get("total_score", 0)) / float(max_s), None
    except Exception as exc:
        return 0.0, f"verifier exception: {exc}"


# ── 主流程 ───────────────────────────────────────────────────────────────────

def run_mode(mode: str, out_dir: Path) -> list[dict]:
    print(f"[{mode}] starting ({len(FINAL_TASK_IDS)} tasks)…", flush=True)
    results = []
    for tid in FINAL_TASK_IDS:
        r = run_one_task(mode, tid, out_dir)
        tag = f"reward={r['reward']:.4f}" if not r["error"] else f"ERR: {r['error'][:80]}"
        print(f"  [{mode}] {tid} → {tag}", flush=True)
        results.append(r)
    mean = sum(r["reward"] for r in results) / len(results)
    print(f"[{mode}] mean_reward={mean:.4f}", flush=True)
    return results


def main() -> None:
    ap = argparse.ArgumentParser(description="Standalone generalization eval (6 modes × 8 final tasks)")
    ap.add_argument("--modes", nargs="+", default=list(CANDIDATES),
                    help="modes to evaluate (default: all)")
    ap.add_argument("--concurrency", type=int, default=6)
    ap.add_argument("--out", type=Path, default=Path("eval/results"))
    args = ap.parse_args()

    # Validate paths before touching anything
    for mode in args.modes:
        ws = workspace_of(mode)
        if not ws.is_dir():
            raise SystemExit(f"workspace not found for {mode}: {ws}")
    assert ROBUST_MODEL.exists(), f"eval/model.py not found at {ROBUST_MODEL}"
    assert RUN_VERIFIER.exists(), f"run-verifier.py not found at {RUN_VERIFIER}"

    out_dir: Path = args.out
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"Standalone eval  modes={args.modes}  concurrency={args.concurrency}  out={out_dir}", flush=True)
    t0 = time.time()

    all_results: dict[str, list[dict]] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        futures = {pool.submit(run_mode, m, out_dir): m for m in args.modes}
        for fut in concurrent.futures.as_completed(futures):
            mode = futures[fut]
            try:
                all_results[mode] = fut.result()
            except Exception as exc:
                print(f"[{mode}] fatal: {exc}", file=sys.stderr)
                all_results[mode] = [{"task": t, "reward": 0.0, "error": str(exc)} for t in FINAL_TASK_IDS]

    elapsed = time.time() - t0
    print(f"\n{'='*60}", flush=True)
    print(f"Done in {elapsed/60:.1f} min", flush=True)
    summary: dict[str, object] = {}
    for mode in args.modes:
        rows = all_results.get(mode, [])
        mean = sum(r["reward"] for r in rows) / len(rows) if rows else 0.0
        summary[mode] = {"mean_reward": round(mean, 6), "tasks": rows}
        h0_mean = summary.get("h0", {}).get("mean_reward")  # type: ignore[union-attr]
        delta = f"  Δh0={mean - h0_mean:+.4f}" if h0_mean is not None and mode != "h0" else ""
        print(f"  {mode:14s}  mean={mean:.4f}{delta}", flush=True)

    report = out_dir / "summary.json"
    report.write_text(json.dumps(summary, indent=2, ensure_ascii=False))
    print(f"\nReport: {report}", flush=True)


if __name__ == "__main__":
    main()
