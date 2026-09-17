"""使用既有 Population Checkpoint 做预算消融，不重新训练。

输入是 ``budget_manifest.py`` 生成的清单。脚本按清单中的
``branchId + candidateId + digest`` 定位不可变候选，先校验源 workspace 的
digest，再复制到 scratch；仅 scratch 副本替换带上游重试的 model.py。
原始 Population、Candidate 和数据集均不挂载、不写入。
"""

from __future__ import annotations

import argparse
import fcntl
import importlib.util
import json
import shutil
import time
import uuid
from pathlib import Path

from budget_manifest import validate_manifest
from budget_results import atomic_json, load_progress, succeeded, summarize


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
    tasks = manifest["benchmark"]["taskIds"]
    rows, history = load_progress(target, record, tasks)
    result = summarize(record, tasks, rows, history)
    if result["status"] == "complete":
        print(f"[{label}] resume: 已完成，跳过", flush=True)
        return result
    candidate = _copy_candidate(record, Path(manifest["source"]["populationRoot"]), scratch_root, base_eval)
    print(f"[{label}] resume: 保留 {result['tasks_completed']}/{len(tasks)} 题，只补未完成题", flush=True)
    atomic_json(target, result)
    for task_id in tasks:
        if task_id in rows and succeeded(rows[task_id]):
            continue
        # 原失败输出移到历史目录，run_one_task 不会覆盖已有轨迹和交付物。
        old_output = out_root / label / task_id
        if task_id in rows or old_output.exists():
            archive = out_root / label / "_attempts" / task_id / uuid.uuid4().hex
            archive.parent.mkdir(parents=True, exist_ok=True)
            if old_output.exists():
                old_output.rename(archive)
            history.append({"task": task_id, "result": rows.get(task_id),
                            "artifacts": str(archive.relative_to(out_root))})
        rows[task_id] = {"task": task_id, "reward": 0.0, "error": "interrupted or still running"}
        atomic_json(target, summarize(record, tasks, rows, history))
        try:
            row = base_eval.run_one_task(label, task_id, candidate, out_root)
        except Exception as exc:  # 单题隔离：不能让一题异常连坐整个 checkpoint
            row = {"task": task_id, "reward": 0.0, "error": f"unhandled: {type(exc).__name__}: {exc}"}
        rows[task_id] = row
        atomic_json(target, summarize(record, tasks, rows, history))
        tag = f"reward={row['reward']:.4f}" if not row.get("error") else f"ERR {str(row['error'])[:120]}"
        print(f"  [{label}] {task_id} {tag}", flush=True)
    return summarize(record, tasks, rows, history)


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
    # 锁保持到 main 返回，阻止两个 driver 同时复用/移动同一题的输出。
    run_lock = (out_root / ".run.lock").open("a")
    fcntl.flock(run_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    for record in records:
        load_progress(out_root / record["label"] / "candidate_summary.json",
                      record, manifest["benchmark"]["taskIds"])
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
    atomic_json(out_root / "summary.json", summary)
    print(f"summary={out_root / 'summary.json'}", flush=True)


if __name__ == "__main__":
    main()
