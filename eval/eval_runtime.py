"""只对候选和题目副本执行 Solver；Verifier 在独立断网容器内打分。"""

import json
import math
import os
import shutil
import subprocess
import uuid
from pathlib import Path

from eval_config import ROBUST_MODEL, require_env


def verifier_reward(result, task_id):
    if not isinstance(result, dict) or str(result.get("id", "")).removeprefix("officeval_") != task_id.removeprefix("officeval_"):
        raise ValueError("Verifier 返回的任务 ID 不匹配")
    if result.get("status") not in ("ok", "error"):
        raise ValueError("Verifier 状态无效")
    total, maximum = result.get("total_score"), result.get("max_score")
    if any(type(value) not in (int, float) or not math.isfinite(value) for value in (total, maximum)) or maximum <= 0:
        raise ValueError("Verifier 必须返回有限总分与正数满分")
    # 保持原独立评测的原始比值，允许扣分后的负 reward，不改历史评分口径。
    reward = total / maximum
    if not math.isfinite(reward):
        raise ValueError("Verifier reward 非有限数字")
    return reward


def task_instruction(task_id: str, inputs: dict) -> str:
    ds = inputs["dataset"]
    spec = ds / "tasks" / f"{task_id}.json"
    if not spec.exists():
        raise RuntimeError(f"task spec not found: {spec}")
    rec = json.loads(spec.read_text(encoding="utf-8"))
    text = rec.get("instruction") or rec.get("task")
    if not text:
        raise RuntimeError(f"no instruction field in {spec}")
    return text


def prepare_candidate_copy(mode: str, scratch_root: Path, config: dict) -> Path:
    """
    把冻结候选 workspace 复制到 scratch，并在副本里换上带重试的 model.py。
    冻结目录本身不被触碰。每个 mode 只需复制一次，8 道题共用这份代码副本。
    """
    src = config["candidates"][mode]
    dst = scratch_root / mode / uuid.uuid4().hex / "_candidate"
    if dst.exists():
        shutil.rmtree(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(src, dst, symlinks=False)
    shutil.copy2(ROBUST_MODEL, dst / "model.py")
    return dst


def prepare_task_workspace(task_id: str, task_out: Path, inputs: dict) -> Path:
    """
    把题目文件复制到独立的 scratch workspace。容器只挂载这个副本，
    数据集目录永不挂载、永不写入。
    """
    ds = inputs["dataset"]
    src = ds / "task_files" / task_id
    if not src.is_dir():
        raise RuntimeError(f"task files not found: {src}")
    dst = task_out / "workspace"
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst, symlinks=False)
    return dst


# ── 单题执行 ─────────────────────────────────────────────────────────────────

def run_one_task(mode: str, task_id: str, candidate_dir: Path, out_dir: Path, config: dict, inputs: dict) -> dict:
    task_out = (out_dir / mode / task_id / f"attempt-{uuid.uuid4().hex}").resolve()
    solver = config["solver"]
    task_out.mkdir(parents=True, exist_ok=True)

    try:
        instruction = task_instruction(task_id, inputs)
        task_ws     = prepare_task_workspace(task_id, task_out, inputs).resolve()
    except Exception as exc:
        return {"task": task_id, "reward": 0.0, "error": f"setup: {exc}"}

    api_key   = require_env("RSI_PROVIDER_API_KEY")
    base_url  = inputs["endpoint"]
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
        "-e", "RSI_MODEL_GATEWAY_DUMMY_KEY",
        "-e", f"RSI_MODEL_GATEWAY_MODEL={solver['model']}",
        "-e", f"RSI_MODEL_GATEWAY_MAX_TOKENS={solver['max_output_tokens']}",
        "-e", f"RSI_SOLVER_MAX_STEPS={solver['max_steps']}",
        solver["image"],
        "python3", "/candidate/run.py",
        "--task", instruction,
        "--answer", "/workspace/.eval_answer.txt",
        "--trace",  "/workspace/.eval_trace.jsonl",
        "--profile", "cowork",
    ]

    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=solver["task_timeout_seconds"],
                              env={**os.environ, "RSI_MODEL_GATEWAY_DUMMY_KEY": api_key})
    except subprocess.TimeoutExpired:
        subprocess.run(["docker", "kill", container], capture_output=True, timeout=30)
        return {"task": task_id, "reward": 0.0, "error": f"timeout {solver['task_timeout_seconds']}s"}
    except Exception as exc:
        return {"task": task_id, "reward": 0.0, "error": str(exc)}

    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip().splitlines()
        snippet = " | ".join(tail[-3:])[:400] if tail else "no output"
        return {"task": task_id, "reward": 0.0, "error": f"exit {proc.returncode}: {snippet}"}

    reward, err = score(task_id, task_ws, solver, inputs)
    return {"task": task_id, "reward": reward, "error": err,
            "attempt": str(task_out.relative_to(out_dir))}


def score(task_id: str, submission_dir: Path, solver: dict, inputs: dict) -> tuple[float, str | None]:
    """
    在容器内运行 verifier —— 宿主机没有 python-docx/openpyxl/python-pptx，
    这些依赖只装在 solver 镜像里。submission 目录以副本形式挂载，
    verifier 会 chdir 进去，因此传副本而非 scratch workspace 本体。
    """
    ev = inputs["evaluator"]
    verifier = ev / "verifiers" / f"{task_id}_verifier.py"
    if not verifier.exists():
        return 0.0, f"verifier missing: {verifier.name}"

    out_root = submission_dir.parent.resolve()
    result_file = out_root / "verifier_result.json"
    result_file.unlink(missing_ok=True)

    # 容器内 agent 以 root 运行，产出文件的权限由候选自己的写文件方式决定。
    # 实测 competition 冠军 (g005-l3) 产出 600 root —— 宿主机 ubuntu 读不了。
    # 先在容器内把 scratch 目录的归属改回宿主机 uid，再做宿主机侧复制。
    chown_cmd = [
        "docker", "run", "--rm", "--network", "none",
        "-v", f"{out_root}:/out",
        solver["image"],
        "chown", "-R", f"{os.getuid()}:{os.getgid()}", "/out",
    ]
    try:
        subprocess.run(chown_cmd, capture_output=True, text=True, timeout=120, check=True)
    except Exception as exc:
        return 0.0, f"chown failed: {exc}"

    # 只把交付物（非隐藏文件）复制给 verifier，排除 agent 的 trace/answer
    sub_copy = out_root / "_submission"
    try:
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
    except Exception as exc:
        # 必须就地返回：若异常穿出去，会触发 main() 的 mode 级兜底，
        # 把该 mode 剩余题目一起标废（run 2 的 competition 就是这样全军覆没）。
        return 0.0, f"submission copy failed: {exc}"

    container = f"verify-{task_id}-{uuid.uuid4().hex[:8]}"
    cmd = [
        "docker", "run", "--rm",
        "--name", container,
        "--network", "none",
        "--cpus", "2", "--memory", "4g", "--pids-limit", "256",
        "-v", f"{ev}:/evaluator:ro",
        "-v", f"{inputs['wrapper']}:/run-verifier.py:ro",
        "-v", f"{sub_copy}:/submission",
        "-v", f"{out_root}:/out",
        solver["image"],
        "python3", "/run-verifier.py",
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
        return verifier_reward(r, task_id), None
    except subprocess.TimeoutExpired:
        subprocess.run(["docker", "kill", container], capture_output=True, timeout=30)
        return 0.0, "verifier timeout"
    except Exception as exc:
        return 0.0, f"verifier exception: {exc}"
