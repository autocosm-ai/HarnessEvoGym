"""逐题结果保存、输入身份校验和完整性统计。"""

import contextlib
import fcntl
import hashlib
import json
import math
import os
import tempfile
from pathlib import Path


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix=".eval-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, indent=2, ensure_ascii=False, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def digest_tree(root):
    """按内容绑定来源；拒绝链接，避免副本与实际读到的内容不同。"""
    root = Path(root)
    digest = hashlib.sha256()
    paths = [root, *sorted(root.rglob("*"))] if root.is_dir() else [root]
    for path in paths:
        if path.is_symlink():
            raise ValueError(f"评测输入不能含符号链接: {path}")
        relative = "." if path == root else path.relative_to(root).as_posix()
        if path.is_dir():
            digest.update(json.dumps(["directory", relative]).encode())
        elif path.is_file():
            content = hashlib.sha256()
            with path.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    content.update(chunk)
            digest.update(json.dumps(["file", relative, content.hexdigest()]).encode())
        else:
            raise ValueError(f"评测输入不是普通文件: {path}")
    return digest.hexdigest()


def run_identity(config, modes, inputs, image_id):
    from eval_config import EVAL_DIR
    descriptor = {
        "version": 1,
        "solver": config["solver"],
        "image_id": image_id,
        "endpoint": inputs["endpoint"],
        "candidates": {m: digest_tree(config["candidates"][m]) for m in sorted(modes)},
        "tasks": {
            task: {
                "instruction": digest_tree(inputs["dataset"] / "tasks" / f"{task}.json"),
                "files": digest_tree(inputs["dataset"] / "task_files" / task),
            }
            for task in config["tasks"]
        },
        "evaluator": digest_tree(inputs["evaluator"]),
        "wrapper": digest_tree(inputs["wrapper"]),
        "runner": {name: digest_tree(EVAL_DIR / name) for name in
                   ("run_eval.py", "eval_config.py", "eval_runtime.py", "eval_results.py", "model.py")},
    }
    serialized = json.dumps(descriptor, sort_keys=True, allow_nan=False).encode()
    return {"fingerprint": hashlib.sha256(serialized).hexdigest(), "inputs": descriptor}


@contextlib.contextmanager
def output_session(out_dir, manifest, resume):
    out_dir.mkdir(parents=True, exist_ok=True)
    with (out_dir / ".eval.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("这个输出目录已有评测进程运行") from None
        target = out_dir / "run.json"
        if resume:
            if not target.is_file() or json.loads(target.read_text()) != manifest:
                raise ValueError("输入、候选、模型、镜像或评测代码已改变，不能复用旧结果；请使用新的 --out")
        else:
            if any(item.name != ".eval.lock" for item in out_dir.iterdir()):
                raise ValueError("输出目录已有内容，请用 --resume 或指定新的 --out")
            atomic_json(target, manifest)
        yield


def valid_result(row, task):
    return (
        isinstance(row, dict) and row.get("task") == task
        and "error" in row and row["error"] is None
        and type(row.get("reward")) in (int, float) and math.isfinite(row["reward"])
    )


def cached_result(path, fingerprint, task):
    if not path.is_file():
        return None
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
        row = record.get("result")
        if record.get("fingerprint") == fingerprint and valid_result(row, task):
            return row
    except (ValueError, AttributeError):
        pass
    return None


def mode_stats(rows, tasks):
    # 检查确切题目集合，不能仅看“返回了几行且都没报错”。
    grouped = {task: [] for task in tasks}
    unexpected = False
    for row in rows:
        task = row.get("task") if isinstance(row, dict) else None
        if not isinstance(task, str) or task not in grouped:
            unexpected = True
        else:
            grouped[task].append(row)
    done, failed, normalized = [], [], []
    for task, matches in grouped.items():
        if len(matches) == 1 and valid_result(matches[0], task):
            row = matches[0]
            done.append(row)
        else:
            failed.append(task)
            row = {"task": task, "reward": None, "error": "missing, duplicate or invalid result"}
            if len(matches) == 1 and isinstance(matches[0].get("error"), str):
                row["error"] = matches[0]["error"]
        normalized.append(row)
    complete = bool(tasks) and not failed and not unexpected
    mean = round(sum(row["reward"] for row in done) / len(done), 6) if done else None
    return {
        "status": "complete" if complete else "incomplete",
        "mean_reward": mean if complete else None,
        "partial_mean_of_completed": mean,
        "tasks_completed": len(done), "tasks_total": len(tasks),
        "failed_tasks": failed, "unexpected_results": unexpected, "tasks": normalized,
    }
