"""预算评测结果的身份校验、逐题续跑和原子保存。"""

import json
import math
import os
import tempfile
from pathlib import Path


IDENTITY_FIELDS = (
    "label", "mode", "budgetScope", "budget", "populationBudget",
    "branchId", "candidateId", "digest", "revision", "checkpoint",
)


def succeeded(row: dict) -> bool:
    reward = row.get("reward")
    return (
        "error" in row and not row["error"]
        and isinstance(reward, (int, float)) and not isinstance(reward, bool)
        and math.isfinite(reward)
    )


def load_progress(target: Path, record: dict, task_ids: list[str]) -> tuple[dict, list]:
    """兼容旧版整组结果；身份或任务变化时拒绝混用旧分数。"""
    if not target.exists():
        return {}, []
    previous = json.loads(target.read_text(encoding="utf-8"))
    for key in IDENTITY_FIELDS:
        if key not in previous or previous[key] != record[key]:
            raise ValueError(f"已有结果与候选身份不符：{target} ({key})")
    for key in ("campaign", "workspace"):
        if key in previous and previous[key] != record[key]:
            raise ValueError(f"已有结果来源不符：{target} ({key})")
    rows = previous["tasks"]
    ids = [row["task"] for row in rows]
    # 旧格式仅在八题结束后写入，因此完整任务清单可从 rows 恢复。
    expected = previous.get("taskIds", ids)
    if expected != task_ids or previous["tasks_total"] != len(task_ids):
        raise ValueError(f"已有结果的任务清单不符：{target}")
    if len(set(ids)) != len(ids) or not set(ids).issubset(task_ids):
        raise ValueError(f"已有结果存在重复或未知任务：{target}")
    return {row["task"]: row for row in rows}, list(previous.get("attempt_history", []))


def summarize(record: dict, task_ids: list[str], rows: dict, history: list) -> dict:
    ordered = [rows[task] for task in task_ids if task in rows]
    completed = [row for row in ordered if succeeded(row)]
    missing = [task for task in task_ids if task not in rows]
    failed = [row["task"] for row in ordered if not succeeded(row)]
    complete = len(completed) == len(task_ids)
    mean = round(sum(row["reward"] for row in completed) / len(completed), 6) if completed else None
    return {
        **{key: record[key] for key in IDENTITY_FIELDS},
        "campaign": record["campaign"], "workspace": record["workspace"],
        "status": "complete" if complete else "incomplete",
        "taskIds": task_ids, "tasks_total": len(task_ids),
        "tasks_completed": len(completed), "failed_tasks": failed,
        "missing_tasks": missing, "mean_reward": mean if complete else None,
        "partial_mean_of_completed": mean, "tasks": ordered,
        "attempt_history": history,
    }


def atomic_json(target: Path, value: dict) -> None:
    """同目录临时文件 + replace，避免进程中断留下半截 JSON。"""
    target.parent.mkdir(parents=True, exist_ok=True)
    name = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=target.parent,
                                         prefix=f".{target.name}.", delete=False) as stream:
            name = stream.name
            json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, target)
    finally:
        if name is not None:
            Path(name).unlink(missing_ok=True)
