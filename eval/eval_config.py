"""独立 OfficeVal 评测的配置与只读预检，不启动容器或模型请求。"""

import json
import os
import re
from pathlib import Path
from urllib.parse import urlsplit

EVAL_DIR = Path(__file__).resolve().parent
REPO_ROOT = EVAL_DIR.parent
DEFAULT_CONFIG = EVAL_DIR / "configs/cowork-main16.json"
ROBUST_MODEL = EVAL_DIR / "model.py"


def require_env(name):
    value = os.environ.get(name, "").strip()
    if not value:
        raise ValueError(f"缺少环境变量 {name}")
    return value


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,119}", value):
        raise ValueError(f"非法标识符: {value!r}")
    return value


def resolve_path(value, root):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("路径必须是非空字符串")
    return (root / value).resolve()


def load_config(path=DEFAULT_CONFIG):
    path = Path(path).resolve()
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or raw.get("version") != 1 or type(raw.get("version")) is not int:
        raise ValueError("评测配置 version 必须为 1")
    if set(raw) != {"version", "candidates", "tasks", "solver"}:
        raise ValueError("配置必须且只能包含 version/candidates/tasks/solver")
    tasks = raw["tasks"]
    if not isinstance(tasks, list) or not tasks or any(
        not isinstance(t, str) or not re.fullmatch(r"officeval_[0-9]+", t) for t in tasks
    ) or len(set(tasks)) != len(tasks):
        raise ValueError("tasks 必须是不重复的 OfficeVal 任务 ID 列表")
    populations = Path(os.environ.get("RSI_POPULATIONS_ROOT") or REPO_ROOT / ".rsi/runs/populations").resolve()
    candidates = raw["candidates"]
    if not isinstance(candidates, dict) or not candidates:
        raise ValueError("candidates 必须是非空对象")
    workspaces = {}
    for name, source in candidates.items():
        identifier(name)
        if not isinstance(source, dict):
            raise ValueError(f"{name}: 候选来源必须是对象")
        if set(source) == {"workspace"}:
            workspace = resolve_path(source["workspace"], path.parent)
        elif set(source) == {"best_report"}:
            report = resolve_path(source["best_report"], path.parent)
            best = json.loads(report.read_text(encoding="utf-8"))
            if best.get("kind") != "BestHarnessImplementation":
                raise ValueError(f"{name}: 不是 best-harness.json")
            # 从报告所在 Population 解析，不依赖报告内旧机器的绝对路径。
            workspace = (report.parent.parent / "branches" / identifier(best["branchId"])
                         / "run/candidates" / identifier(best["candidateId"]) / "workspace")
        elif set(source) == {"population", "branch", "candidate"}:
            workspace = (populations / identifier(source["population"]) / "branches"
                         / identifier(source["branch"]) / "run/candidates"
                         / identifier(source["candidate"]) / "workspace")
        else:
            raise ValueError(f"{name}: 需要 workspace、best_report 或 population/branch/candidate")
        workspaces[name] = workspace.resolve()
    solver = raw["solver"]
    if not isinstance(solver, dict) or set(solver) != {
        "model", "image", "max_steps", "max_output_tokens", "task_timeout_seconds"
    }:
        raise ValueError("solver 字段不完整或包含未知设置")
    solver = dict(solver)
    solver["image"] = os.environ.get("RSI_SOLVER_IMAGE") or solver["image"]
    for key in ("model", "image"):
        if not isinstance(solver[key], str) or not solver[key].strip():
            raise ValueError(f"solver.{key} 必须是非空字符串")
    for key in ("max_steps", "max_output_tokens", "task_timeout_seconds"):
        if key == "task_timeout_seconds" and solver[key] is None:
            continue
        if type(solver[key]) is not int or solver[key] <= 0:
            raise ValueError(f"solver.{key} 必须是正整数（timeout 可用 null）")
    return {"tasks": tasks, "candidates": workspaces, "solver": solver}


def preflight(config, modes, out_dir, *, require_credentials=True):
    if not modes or len(set(modes)) != len(modes) or any(m not in config["candidates"] for m in modes):
        raise ValueError("modes 必须是不重复的已配置候选名")
    dataset = Path(require_env("RSI_OFFICEVAL_DATASET_ROOT")).resolve()
    evaluator = Path(require_env("RSI_OFFICEVAL_EVALUATOR_ROOT")).resolve()
    wrapper = Path(os.environ.get("RSI_RUN_VERIFIER") or
                   REPO_ROOT / "docker/omegause-officeval/run-verifier.py").resolve()
    sources = [dataset, evaluator, *config["candidates"].values(), wrapper, ROBUST_MODEL,
               *EVAL_DIR.glob("*.py"), EVAL_DIR / "configs"]
    output = out_dir.resolve()
    for source in sources:
        if output == source or output in source.parents or source in output.parents:
            raise ValueError(f"输出目录必须与输入目录分离: {source}")
    for name in modes:
        for filename in ("run.py", "model.py"):
            if not (config["candidates"][name] / filename).is_file():
                raise ValueError(f"{name}: 缺少候选文件 {filename}")
    for task in config["tasks"]:
        spec = dataset / "tasks" / f"{task}.json"
        data = json.loads(spec.read_text(encoding="utf-8"))
        instruction = data.get("instruction") or data.get("task")
        if not isinstance(instruction, str) or not instruction.strip():
            raise ValueError(f"{task}: 缺少有效题目描述")
        if not (dataset / "task_files" / task).is_dir():
            raise ValueError(f"{task}: 缺少题目文件目录")
        if not (evaluator / "verifiers" / f"{task}_verifier.py").is_file():
            raise ValueError(f"{task}: 缺少 verifier")
    for required in (wrapper, ROBUST_MODEL):
        if not required.is_file():
            raise ValueError(f"缺少文件: {required}")
    endpoint = os.environ.get("RSI_PROVIDER_BASE_URL", "").rstrip("/")
    if require_credentials:
        require_env("RSI_PROVIDER_API_KEY")
        require_env("RSI_PROVIDER_BASE_URL")
    if endpoint:
        parsed = urlsplit(endpoint)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("Provider URL 必须是不含凭据、查询参数的 http(s) 地址")
    return {"dataset": dataset, "evaluator": evaluator, "wrapper": wrapper, "endpoint": endpoint}
