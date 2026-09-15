"""
独立泛化性评测 — 6 个候选 (h0 + 5 mode 冠军) × 8 道 sealed final 题。

隔离保证（重要）：
  1. 冻结的候选 workspace 只读复制到 scratch 目录，绝不原地修改。
     model.py 的替换只发生在副本里。
  2. 数据集目录绝不挂载给容器。每道题把题目文件复制到独立的 scratch
     workspace，容器只在副本上工作。数据集永远不被写入。

唯一的行为改动：副本里的 model.py 换成 eval/model.py（带上游断流重试）。
agent.py / run.py / tools.py / profiles / skills 全部保持冠军原样。

用法：
  export RSI_PROVIDER_API_KEY=...
  export RSI_PROVIDER_BASE_URL=https://api.zcloudapi.com/v1
  export RSI_OFFICEVAL_DATASET_ROOT=/path/to/OmegaUse-OfficeVal-Dataset
  export RSI_OFFICEVAL_EVALUATOR_ROOT=/path/to/OmegaUse-OfficeVal
  python3 eval/run_eval.py --out eval/results
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path

# ── 常量 ─────────────────────────────────────────────────────────────────────

EVAL_DIR      = Path(__file__).resolve().parent
_SIXTEEN_ROOT = Path("/data/workspace/liuzhou/projs/01-code-apps/项目-Deepseek-Harness-RSI"
                     "/002-Code/.WorkTrees/016-fix-solver-failure-feedback")
_POPULATIONS  = _SIXTEEN_ROOT / ".rsi/runs/populations"
ROBUST_MODEL  = EVAL_DIR / "model.py"
RUN_VERIFIER  = _SIXTEEN_ROOT / "docker/omegause-officeval/run-verifier.py"
SOLVER_IMAGE  = "harness-rsi/omegause-officeval:v1"

_POP_PREFIX = "cowork-main16-ff-train8-test8-terra-xhigh-20260907-v1-"

FINAL_TASK_IDS = [
    "officeval_011", "officeval_026", "officeval_033", "officeval_051",
    "officeval_070", "officeval_088", "officeval_089", "officeval_097",
]

# mode -> (population suffix, branch, candidate id)
CANDIDATES: dict[str, tuple[str, str, str]] = {
    "h0":          ("single",      "branch-001", "h0"),
    "single":      ("single",      "branch-001", "g016-l3"),
    "independent": ("independent", "branch-002", "g008-l3"),
    "mutualism":   ("mutualism",   "branch-001", "g008-l3"),
    "competition": ("competition", "branch-002", "g005-l3"),
    "combined":    ("combined",    "branch-002", "g002-l3"),
}

SOLVER_MAX_STEPS  = 12
MAX_OUTPUT_TOKENS = 8192
TASK_TIMEOUT_S    = 3600


def _require(var: str) -> str:
    v = os.environ.get(var, "").strip()
    if not v:
        raise SystemExit(f"ERROR: environment variable {var} is not set")
    return v


def frozen_workspace(mode: str) -> Path:
    """冻结的候选 workspace —— 只读，绝不修改。"""
    suffix, branch, cand = CANDIDATES[mode]
    return (_POPULATIONS / f"{_POP_PREFIX}{suffix}" / "branches" / branch
            / "run" / "candidates" / cand / "workspace")


def task_instruction(task_id: str) -> str:
    ds = Path(_require("RSI_OFFICEVAL_DATASET_ROOT"))
    spec = ds / "tasks" / f"{task_id}.json"
    if not spec.exists():
        raise RuntimeError(f"task spec not found: {spec}")
    rec = json.loads(spec.read_text(encoding="utf-8"))
    text = rec.get("instruction") or rec.get("task")
    if not text:
        raise RuntimeError(f"no instruction field in {spec}")
    return text


def prepare_candidate_copy(mode: str, scratch_root: Path) -> Path:
    """
    把冻结候选 workspace 复制到 scratch，并在副本里换上带重试的 model.py。
    冻结目录本身不被触碰。每个 mode 只需复制一次，8 道题共用这份代码副本。
    """
    src = frozen_workspace(mode)
    dst = scratch_root / mode / "_candidate"
    if dst.exists():
        shutil.rmtree(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(src, dst, symlinks=False)
    shutil.copy2(ROBUST_MODEL, dst / "model.py")
    return dst


def prepare_task_workspace(task_id: str, task_out: Path) -> Path:
    """
    把题目文件复制到独立的 scratch workspace。容器只挂载这个副本，
    数据集目录永不挂载、永不写入。
    """
    ds = Path(_require("RSI_OFFICEVAL_DATASET_ROOT"))
    src = ds / "task_files" / task_id
    if not src.is_dir():
        raise RuntimeError(f"task files not found: {src}")
    dst = task_out / "workspace"
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst, symlinks=False)
    return dst


# ── 单题执行 ─────────────────────────────────────────────────────────────────

def run_one_task(mode: str, task_id: str, candidate_dir: Path, out_dir: Path) -> dict:
    task_out = (out_dir / mode / task_id).resolve()
    task_out.mkdir(parents=True, exist_ok=True)

    try:
        instruction = task_instruction(task_id)
        task_ws     = prepare_task_workspace(task_id, task_out).resolve()
    except Exception as exc:
        return {"task": task_id, "reward": 0.0, "error": f"setup: {exc}"}

    api_key   = _require("RSI_PROVIDER_API_KEY")
    base_url  = _require("RSI_PROVIDER_BASE_URL").rstrip("/")
    container = f"eval-{mode}-{task_id}-{uuid.uuid4().hex[:8]}"

    cmd = [
        "docker", "run", "--rm",
        "--name", container,
        "--network", "bridge",
        "--cpus", "4", "--memory", "8g", "--pids-limit", "512",
        # 候选代码副本（只读）
        "-v", f"{candidate_dir.resolve()}:/candidate:ro",
        # 题目文件副本（可写；这是 scratch，不是数据集）
        "-v", f"{task_ws}:/workspace",
        "-w", "/workspace",
        "-e", f"RSI_MODEL_GATEWAY_BASE_URL={base_url}",
        "-e", f"RSI_MODEL_GATEWAY_DUMMY_KEY={api_key}",
        "-e", "RSI_MODEL_GATEWAY_MODEL=gpt-5.6-terra",
        "-e", f"RSI_MODEL_GATEWAY_MAX_TOKENS={MAX_OUTPUT_TOKENS}",
        "-e", f"RSI_SOLVER_MAX_STEPS={SOLVER_MAX_STEPS}",
        SOLVER_IMAGE,
        "python3", "/candidate/run.py",
        "--task", instruction,
        "--answer", "/workspace/.eval_answer.txt",
        "--trace",  "/workspace/.eval_trace.jsonl",
        "--profile", "cowork",
    ]

    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=TASK_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        subprocess.run(["docker", "kill", container], capture_output=True)
        return {"task": task_id, "reward": 0.0, "error": f"timeout {TASK_TIMEOUT_S}s"}
    except Exception as exc:
        return {"task": task_id, "reward": 0.0, "error": str(exc)}

    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip().splitlines()
        snippet = " | ".join(tail[-3:])[:400] if tail else "no output"
        return {"task": task_id, "reward": 0.0, "error": f"exit {proc.returncode}: {snippet}"}

    reward, err = score(task_id, task_ws)
    return {"task": task_id, "reward": reward, "error": err}


def score(task_id: str, submission_dir: Path) -> tuple[float, str | None]:
    """
    在容器内运行 verifier —— 宿主机没有 python-docx/openpyxl/python-pptx，
    这些依赖只装在 solver 镜像里。submission 目录以副本形式挂载，
    verifier 会 chdir 进去，因此传副本而非 scratch workspace 本体。
    """
    ev = Path(_require("RSI_OFFICEVAL_EVALUATOR_ROOT")).resolve()
    verifier = ev / "verifiers" / f"{task_id}_verifier.py"
    if not verifier.exists():
        return 0.0, f"verifier missing: {verifier.name}"

    out_root = submission_dir.parent.resolve()
    result_file = out_root / "verifier_result.json"
    result_file.unlink(missing_ok=True)

    # 只把交付物（非隐藏文件）复制给 verifier，排除 agent 的 trace/answer
    sub_copy = out_root / "_submission"
    if sub_copy.exists():
        shutil.rmtree(sub_copy)
    sub_copy.mkdir(parents=True)
    for item in submission_dir.iterdir():
        if item.name.startswith("."):
            continue
        if item.is_dir():
            shutil.copytree(item, sub_copy / item.name, symlinks=False)
        else:
            shutil.copy2(item, sub_copy / item.name)

    container = f"verify-{task_id}-{uuid.uuid4().hex[:8]}"
    cmd = [
        "docker", "run", "--rm",
        "--name", container,
        "--network", "none",
        "--cpus", "2", "--memory", "4g", "--pids-limit", "256",
        "-v", f"{ev}:/evaluator:ro",
        "-v", f"{sub_copy}:/submission",
        "-v", f"{out_root}:/out",
        SOLVER_IMAGE,
        "python3", "/opt/harness-rsi/run-officeval-verifier.py",
        "--verifier",    f"/evaluator/verifiers/{task_id}_verifier.py",
        "--submission",  "/submission",
        "--output",      "/out/verifier_result.json",
        "--expected-id", task_id,
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        if proc.returncode != 0:
            tail = (proc.stderr or proc.stdout or "").strip().splitlines()
            return 0.0, f"verifier: {' | '.join(tail[-2:])[:300]}"
        r = json.loads(result_file.read_text(encoding="utf-8"))
        max_score = float(r.get("max_score") or 1) or 1.0
        return float(r.get("total_score", 0)) / max_score, None
    except subprocess.TimeoutExpired:
        subprocess.run(["docker", "kill", container], capture_output=True)
        return 0.0, "verifier timeout"
    except Exception as exc:
        return 0.0, f"verifier exception: {exc}"


# ── 每个 mode 串行跑 8 题 ────────────────────────────────────────────────────

def run_mode(mode: str, out_dir: Path, scratch_root: Path) -> list[dict]:
    try:
        candidate_dir = prepare_candidate_copy(mode, scratch_root)
    except Exception as exc:
        print(f"[{mode}] candidate copy failed: {exc}", file=sys.stderr, flush=True)
        return [{"task": t, "reward": 0.0, "error": f"candidate copy: {exc}"} for t in FINAL_TASK_IDS]

    print(f"[{mode}] start ({len(FINAL_TASK_IDS)} tasks)", flush=True)
    rows = []
    for tid in FINAL_TASK_IDS:
        r = run_one_task(mode, tid, candidate_dir, out_dir)
        tag = f"reward={r['reward']:.4f}" if not r["error"] else f"ERR {r['error'][:90]}"
        print(f"  [{mode}] {tid}  {tag}", flush=True)
        rows.append(r)
    mean = sum(x["reward"] for x in rows) / len(rows)
    failed = [r["task"] for r in rows if r["error"]]
    if failed:
        # 有题未完成 —— 不报均值，避免把失败当成真实 0 分
        print(f"[{mode}] INCOMPLETE  {len(rows)-len(failed)}/{len(rows)} 完成"
              f"  未完成: {', '.join(failed)}", flush=True)
    else:
        print(f"[{mode}] done  mean_reward={mean:.4f}", flush=True)
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--modes", nargs="+", default=list(CANDIDATES))
    ap.add_argument("--concurrency", type=int, default=6)
    ap.add_argument("--out", type=Path, default=Path("eval/results"))
    args = ap.parse_args()

    # 前置校验
    for m in args.modes:
        if m not in CANDIDATES:
            raise SystemExit(f"unknown mode: {m}")
        ws = frozen_workspace(m)
        if not ws.is_dir():
            raise SystemExit(f"frozen workspace missing for {m}: {ws}")
    for p in (ROBUST_MODEL, RUN_VERIFIER):
        if not p.exists():
            raise SystemExit(f"required file missing: {p}")
    for v in ("RSI_PROVIDER_API_KEY", "RSI_PROVIDER_BASE_URL",
              "RSI_OFFICEVAL_DATASET_ROOT", "RSI_OFFICEVAL_EVALUATOR_ROOT"):
        _require(v)

    out_dir = args.out.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    scratch_root = out_dir / "_scratch"
    scratch_root.mkdir(parents=True, exist_ok=True)

    print(f"modes={args.modes}  concurrency={args.concurrency}  out={out_dir}", flush=True)
    print("dataset is never mounted; task files are copied per task", flush=True)
    t0 = time.time()

    results: dict[str, list[dict]] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        futures = {pool.submit(run_mode, m, out_dir, scratch_root): m for m in args.modes}
        for fut in concurrent.futures.as_completed(futures):
            m = futures[fut]
            try:
                results[m] = fut.result()
            except Exception as exc:
                print(f"[{m}] fatal: {exc}", file=sys.stderr, flush=True)
                results[m] = [{"task": t, "reward": 0.0, "error": str(exc)} for t in FINAL_TASK_IDS]

    elapsed = (time.time() - t0) / 60
    print(f"\n{'='*64}\nfinished in {elapsed:.1f} min\n{'='*64}", flush=True)

    def mode_stats(rows: list[dict]) -> dict:
        """只有全部题目完成才给出正式均值。任何一题失败 -> incomplete，
        mean_reward 置 None，避免把基础设施故障当成真实 0 分计入分数。"""
        total  = len(rows)
        failed = [r["task"] for r in rows if r["error"]]
        done   = [r for r in rows if not r["error"]]
        if total and not failed:
            return {
                "status": "complete",
                "mean_reward": round(sum(r["reward"] for r in rows) / total, 6),
                "tasks_completed": total,
                "tasks_total": total,
                "failed_tasks": [],
                "tasks": rows,
            }
        return {
            "status": "incomplete",
            "mean_reward": None,          # 正式分数不予出具
            "partial_mean_of_completed": (
                round(sum(r["reward"] for r in done) / len(done), 6) if done else None
            ),
            "tasks_completed": len(done),
            "tasks_total": total,
            "failed_tasks": failed,
            "tasks": rows,
        }

    summary: dict[str, object] = {m: mode_stats(results.get(m, [])) for m in args.modes}

    h0_stats = summary.get("h0")
    h0_mean = h0_stats["mean_reward"] if isinstance(h0_stats, dict) else None

    for m in args.modes:
        s = summary[m]
        assert isinstance(s, dict)
        if s["status"] == "complete":
            line = f"  {m:14s} mean={s['mean_reward']:.4f}  ok={s['tasks_completed']}/{s['tasks_total']}"
            # 只有双方都完整时才给出对比
            if h0_mean is not None and m != "h0":
                line += f"   vs h0: {s['mean_reward'] - h0_mean:+.4f}"
            elif m != "h0":
                line += "   vs h0: n/a (h0 incomplete)"
        else:
            pm = s["partial_mean_of_completed"]
            pm_txt = f"{pm:.4f}" if pm is not None else "n/a"
            line = (f"  {m:14s} INCOMPLETE  ok={s['tasks_completed']}/{s['tasks_total']}"
                    f"  (完成题部分均值={pm_txt}, 非正式)"
                    f"  失败: {', '.join(s['failed_tasks'])}")
        print(line, flush=True)

    incomplete = [m for m in args.modes if summary[m]["status"] == "incomplete"]  # type: ignore[index]
    report = out_dir / "summary.json"
    report.write_text(json.dumps({
        "run_complete": not incomplete,
        "incomplete_modes": incomplete,
        "modes": summary,
    }, indent=2, ensure_ascii=False), encoding="utf-8")

    print(f"\nreport: {report}", flush=True)
    if incomplete:
        print(f"\n⚠  未产出正式结果 —— 以下 mode 有题目失败: {', '.join(incomplete)}", flush=True)
        print("   正式均值与 mode 对比需要 6 个 mode 的 8 道题全部完成。", flush=True)
    else:
        print("\n✓ 全部 mode 完整完成，正式均值有效。", flush=True)


if __name__ == "__main__":
    main()
