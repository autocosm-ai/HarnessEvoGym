"""可配置的独立 OfficeVal 评测。默认配置保留历史 6 候选 × 8 题。
只运行候选和题目的副本；这是兼容评测工具，不生成 sealed-final 官方审计链。
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import subprocess
import sys
import time
from pathlib import Path

from eval_config import DEFAULT_CONFIG, load_config, preflight
from eval_results import atomic_json, cached_result, mode_stats, output_session, run_identity
from eval_runtime import prepare_candidate_copy, run_one_task


def run_mode(mode, out_dir, config, inputs, fingerprint, resume):
    rows = []
    candidate_dir = None
    for task in config["tasks"]:
        result_path = out_dir / mode / task / "result.json"
        row = cached_result(result_path, fingerprint, task) if resume else None
        if row is not None:
            print(f"[{mode}] {task}: 复用已完成结果 {row['reward']:.4f}", flush=True)
        else:
            try:
                if candidate_dir is None:
                    candidate_dir = prepare_candidate_copy(mode, out_dir / "_scratch", config)
                row = run_one_task(mode, task, candidate_dir, out_dir, config, inputs)
            except Exception as exc:
                row = {"task": task, "reward": None,
                       "error": f"{type(exc).__name__}: {exc}"}
            # 每完成一题就落盘；后续题目或进程失败不会抹掉前面的得分。
            atomic_json(result_path, {"fingerprint": fingerprint, "result": row})
            print(f"[{mode}] {task}: " + (
                f"ERR {row['error']}" if row["error"] else f"reward={row['reward']:.4f}"
            ), flush=True)
        rows.append(row)
    return rows


def make_report(results, modes, tasks):
    summary = {mode: mode_stats(results.get(mode, []), tasks) for mode in modes}
    incomplete = [mode for mode in modes if summary[mode]["status"] != "complete"]
    return {"run_complete": not incomplete, "incomplete_modes": incomplete, "modes": summary}


def execute(args):
    config = load_config(args.config)
    modes = args.modes or list(config["candidates"])
    if args.concurrency < 1:
        raise ValueError("--concurrency 必须大于零")
    out_dir = args.out.resolve()
    inputs = preflight(config, modes, out_dir, require_credentials=not args.dry_run)
    if args.dry_run:
        print(json.dumps({
            "status": "validated", "modes": {m: str(config["candidates"][m]) for m in modes},
            "tasks": config["tasks"], "solver": config["solver"], "out": str(out_dir),
        }, indent=2, ensure_ascii=False))
        return 0

    image = subprocess.run(
        ["docker", "image", "inspect", "--format", "{{.Id}}", config["solver"]["image"]],
        check=True, capture_output=True, text=True, timeout=30,
    ).stdout.strip()
    if not image.startswith("sha256:"):
        raise ValueError("无法确认 Solver 镜像内容 ID")
    manifest = run_identity(config, modes, inputs, image)
    # 固定本次实际运行的镜像，避免任务之间 tag 被改指。
    config = {**config, "solver": {**config["solver"], "image": image}}
    with output_session(out_dir, manifest, args.resume):
        results = {}
        start = time.monotonic()
        atomic_json(out_dir / "summary.json", make_report(results, modes, config["tasks"]))
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as pool:
            futures = {
                pool.submit(run_mode, mode, out_dir, config, inputs,
                            manifest["fingerprint"], args.resume): mode
                for mode in modes
            }
            for future in concurrent.futures.as_completed(futures):
                mode = futures[future]
                try:
                    results[mode] = future.result()
                except Exception as exc:
                    print(f"[{mode}] 结果写入或执行失败: {exc}", file=sys.stderr, flush=True)
                    # 保留已经落盘的成功题目；未返回的题目仍按缺失处理。
                    results[mode] = [
                        row for task in config["tasks"]
                        if (row := cached_result(out_dir / mode / task / "result.json",
                                                 manifest["fingerprint"], task)) is not None
                    ]
                atomic_json(out_dir / "summary.json", make_report(results, modes, config["tasks"]))
        report = make_report(results, modes, config["tasks"])
        atomic_json(out_dir / "summary.json", report)
        for mode, stats in report["modes"].items():
            print(f"{mode}: {stats['status']}  {stats['tasks_completed']}/{stats['tasks_total']}"
                  f"  mean={stats['mean_reward']}", flush=True)
        print(f"耗时 {(time.monotonic()-start)/60:.1f} 分钟；报告: {out_dir / 'summary.json'}")
        return 0 if report["run_complete"] else 2


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--modes", nargs="+")
    parser.add_argument("--concurrency", type=int, default=6)
    parser.add_argument("--out", type=Path, default=Path("eval/results"))
    parser.add_argument("--resume", action="store_true", help="只复用相同输入下已经打分成功的题目")
    parser.add_argument("--dry-run", action="store_true", help="检查配置和本地文件，不调用 Docker 或 API")
    args = parser.parse_args(argv)
    try:
        return execute(args)
    except (ValueError, OSError, subprocess.SubprocessError) as exc:
        print(f"评测未完成: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
