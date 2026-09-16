"""使用既有 Population Checkpoint 做预算消融，不重新训练。

输入是 ``budget_manifest.py`` 生成的清单。脚本按清单中的
``branchId + candidateId + digest`` 定位不可变候选，先校验源 workspace 的
digest，再复制到 scratch；仅 scratch 副本替换带上游重试的 model.py。
原始 Population、Candidate 和数据集均不挂载、不写入。
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import shutil
import sys
import tempfile
import time
from pathlib import Path

from budget_manifest import validate_manifest


EVAL_DIR = Path(__file__).resolve().parent
ROBUST_MODEL = EVAL_DIR / "model.py"


def _load_base_eval():
    spec = importlib.util.spec_from_file_location("budget_base_eval", EVAL_DIR / "run_eval.py")
    if spec is None or spec.loader is None:
        raise RuntimeError("无法加载 eval/run_eval.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _copy_candidate(record: dict, population_root: Path, scratch_root: Path, base_eval) -> Path:
    source = population_root / record["campaign"] / record["workspace"]
    destination = scratch_root / record["label"] / "_candidate"
    if destination.exists():
        shutil.rmtree(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source, destination, symlinks=False)
    # 行为替换只存在于 scratch。冻结 workspace 的 digest 已在 manifest 校验阶段检查。
    shutil.copy2(ROBUST_MODEL, destination / "model.py")
    return destination


def _run_record(record: dict, manifest: dict, out_root: Path, scratch_root: Path, base_eval) -> dict:
    label = record["label"]
    target = out_root / label / "candidate_summary.json"
    if target.is_file():
        try:
            previous = json.loads(target.read_text(encoding="utf-8"))
            if previous.get("status") == "complete":
                print(f"[{label}] resume: 已完成，跳过", flush=True)
                return previous
        except (OSError, json.JSONDecodeError):
            pass
    candidate = _copy_candidate(record, Path(manifest["source"]["populationRoot"]), scratch_root, base_eval)
    tasks = manifest["benchmark"]["taskIds"]
    rows = []
    for task_id in tasks:
        try:
            row = base_eval.run_one_task(label, task_id, candidate, out_root)
        except Exception as exc:  # 单题隔离：不能让一题异常连坐整个 checkpoint
            row = {"task": task_id, "reward": 0.0, "error": f"unhandled: {type(exc).__name__}: {exc}"}
        rows.append(row)
        tag = f"reward={row['reward']:.4f}" if not row.get("error") else f"ERR {str(row['error'])[:120]}"
        print(f"  [{label}] {task_id} {tag}", flush=True)
    failed = [row["task"] for row in rows if row.get("error")]
    complete = not failed and len(rows) == len(tasks)
    result = {
        "status": "complete" if complete else "incomplete",
        "label": label,
        "mode": record["mode"],
        "budgetScope": record["budgetScope"],
        "budget": record["budget"],
        "populationBudget": record["populationBudget"],
        "branchId": record["branchId"],
        "candidateId": record["candidateId"],
        "digest": record["digest"],
        "revision": record["revision"],
        "checkpoint": record["checkpoint"],
        "tasks_completed": len(rows) - len(failed),
        "tasks_total": len(tasks),
        "failed_tasks": failed,
        "mean_reward": round(sum(row["reward"] for row in rows) / len(rows), 6) if complete else None,
        "partial_mean_of_completed": (
            round(sum(row["reward"] for row in rows if not row.get("error")) / (len(rows) - len(failed)), 6)
            if len(rows) != len(failed) else None
        ),
        "tasks": rows,
    }
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="评测 Population Checkpoint 的预算消融")
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--labels", nargs="*", help="只运行指定 label；默认运行清单全部候选")
    parser.add_argument("--concurrency", type=int, default=2)
    parser.add_argument("--skip-digest-check", action="store_true", help="仅用于本地诊断，不建议正式评测")
    args = parser.parse_args()
    if args.concurrency < 1:
        raise SystemExit("--concurrency 必须 >= 1")
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    records = validate_manifest(manifest, check_digest=not args.skip_digest_check)
    if args.labels:
        wanted = set(args.labels)
        records = [record for record in records if record["label"] in wanted]
        missing = wanted - {record["label"] for record in records}
        if missing:
            raise SystemExit(f"manifest 中没有这些 label：{', '.join(sorted(missing))}")
    if not records:
        raise SystemExit("没有待评测候选")
    for var in ("RSI_PROVIDER_API_KEY", "RSI_PROVIDER_BASE_URL", "RSI_OFFICEVAL_DATASET_ROOT", "RSI_OFFICEVAL_EVALUATOR_ROOT"):
        if not __import__("os").environ.get(var, "").strip():
            raise SystemExit(f"ERROR: environment variable {var} is not set")
    if not ROBUST_MODEL.is_file():
        raise SystemExit(f"缺少 robust model：{ROBUST_MODEL}")
    out_root = args.out.resolve()
    out_root.mkdir(parents=True, exist_ok=True)
    scratch_root = out_root / "_scratch"
    scratch_root.mkdir(parents=True, exist_ok=True)
    base_eval = _load_base_eval()
    print(f"candidates={len(records)} concurrency={args.concurrency} out={out_root}", flush=True)
    started = time.time()
    results = []
    # 使用线程并行不同 checkpoint；每个 checkpoint 内题目仍串行，避免同一 workspace 竞争。
    import concurrent.futures

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        futures = [pool.submit(_run_record, record, manifest, out_root, scratch_root, base_eval) for record in records]
        for future in concurrent.futures.as_completed(futures):
            results.append(future.result())
    results.sort(key=lambda row: row["label"])
    h0 = next((row for row in results if row["label"] == "h0"), None)
    h0_mean = h0.get("mean_reward") if h0 and h0.get("status") == "complete" else None
    for row in results:
        row["delta_vs_h0"] = (
            round(row["mean_reward"] - h0_mean, 6)
            if row.get("status") == "complete" and h0_mean is not None and row["label"] != "h0" else None
        )
    summary = {
        "kind": "BudgetAblationEvaluation",
        "manifest": str(args.manifest.resolve()),
        "run_complete": all(row.get("status") == "complete" for row in results),
        "candidates": results,
        "elapsed_minutes": round((time.time() - started) / 60, 2),
    }
    (out_root / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"summary={out_root / 'summary.json'}", flush=True)


if __name__ == "__main__":
    main()
