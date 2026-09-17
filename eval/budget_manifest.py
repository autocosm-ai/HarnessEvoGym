"""从 Population Checkpoint 构建、校验预算消融评测清单。

清单只保存相对路径和不可变身份，不复制或修改冻结 Candidate。N1 使用总预算
B2/B4/B8；N2 同时记录每个 Branch 的 G2/G4/G8，并明确对应的总预算为 B4/B8/B16。
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any, Iterable


DEFAULT_MODES = ("single", "independent", "mutualism", "competition", "combined")
POPULATION_PREFIX = "cowork-main16-ff-train8-test8-terra-xhigh-20260907-v1-"
DEFAULT_BUDGETS = {"single": (2, 4, 8, 12, 16), "n2": (4, 8, 12, 16)}
DEFAULT_GENERATIONS = (2, 4, 8)


def _require_dict(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} 必须是对象")
    return value


def _read_json(path: Path) -> dict[str, Any]:
    try:
        return _require_dict(json.loads(path.read_text(encoding="utf-8")), str(path))
    except json.JSONDecodeError as exc:
        raise ValueError(f"检查点 JSON 无法解析：{path}: {exc}") from exc


def _identity_from_entry(entry: dict[str, Any], *, label: str) -> dict[str, Any]:
    candidate_id = entry.get("candidateId")
    digest = entry.get("digest")
    revision = entry.get("revision")
    branch_id = entry.get("branchId")
    if not isinstance(branch_id, str) or not branch_id:
        raise ValueError(f"{label} 缺少 branchId")
    if not isinstance(candidate_id, str) or not candidate_id:
        raise ValueError(f"{label} 缺少 candidateId")
    if not isinstance(digest, str) or len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
        raise ValueError(f"{label} digest 不是小写 SHA-256")
    if not isinstance(revision, str) or not revision:
        raise ValueError(f"{label} 缺少 revision")
    return {"branchId": branch_id, "candidateId": candidate_id, "digest": digest, "revision": revision}


def _workspace_relative(branch_id: str, candidate_id: str) -> str:
    # branchId/candidateId 来自已校验的协议对象；不允许把它们当作任意路径。
    if any(part in {"", ".", ".."} or "/" in part or "\\" in part for part in (branch_id, candidate_id)):
        raise ValueError("branchId/candidateId 含非法路径片段")
    return f"branches/{branch_id}/run/candidates/{candidate_id}/workspace"


def _population_candidate(
    *,
    mode: str,
    campaign_root: Path,
    checkpoint_path: Path,
    checkpoint: dict[str, Any],
    budget_scope: str,
    budget_value: int,
    branch_generation: int | None = None,
    branch_id: str | None = None,
) -> dict[str, Any]:
    if checkpoint.get("mode") != mode:
        raise ValueError(f"检查点 mode 不匹配：{checkpoint_path}")
    if branch_generation is None:
        best = _require_dict(checkpoint.get("populationBest"), f"{checkpoint_path}.populationBest")
    else:
        if checkpoint.get("branchId") != branch_id:
            raise ValueError(f"Branch 检查点 branchId 不匹配：{checkpoint_path}")
        best = _require_dict(checkpoint.get("incumbent"), f"{checkpoint_path}.incumbent")
        # BranchGenerationCheckpoint 把 branchId 放在顶层，incumbent 只保存 Candidate 身份。
        best = {**best, "branchId": branch_id}
    identity = _identity_from_entry(best, label=f"{checkpoint_path}")
    workspace = _workspace_relative(identity["branchId"], identity["candidateId"])
    workspace_abs = campaign_root / workspace
    if not workspace_abs.is_dir():
        raise ValueError(f"Candidate workspace 不存在：{workspace_abs}")
    return {
        "label": f"{mode}-{'g' if branch_generation is not None else 'b'}{budget_value:02d}"
        + (f"-{identity['branchId']}" if branch_generation is not None else ""),
        "mode": mode,
        "budgetScope": budget_scope,
        "budget": budget_value,
        "populationBudget": (budget_value if budget_scope == "total" else budget_value * 2),
        "branchGeneration": branch_generation,
        "branchId": identity["branchId"],
        "candidateId": identity["candidateId"],
        "digest": identity["digest"],
        "revision": identity["revision"],
        "campaign": campaign_root.name,
        "checkpoint": checkpoint_path.relative_to(campaign_root).as_posix(),
        "workspace": workspace,
    }


def build_manifest(
    population_root: Path,
    *,
    modes: Iterable[str] = DEFAULT_MODES,
    include_generations: bool = True,
    prefix: str = POPULATION_PREFIX,
) -> dict[str, Any]:
    modes = tuple(modes)
    candidates: list[dict[str, Any]] = []
    # H0 只加入一次，后续所有 Mode 共用同一份 baseline。
    h0_campaign = population_root / f"{prefix}single"
    h0_path = h0_campaign / "public/checkpoints/budget-0000.json"
    h0 = _read_json(h0_path)
    h0_entry = _population_candidate(
        mode="single", campaign_root=h0_campaign, checkpoint_path=h0_path,
        checkpoint=h0, budget_scope="total", budget_value=0,
    )
    h0_entry["label"] = "h0"
    h0_entry["mode"] = "h0"
    candidates.append(h0_entry)

    for mode in modes:
        campaign = population_root / f"{prefix}{mode}"
        if not campaign.is_dir():
            raise ValueError(f"Population 不存在：{campaign}")
        if mode == "single":
            budgets = DEFAULT_BUDGETS["single"]
        else:
            budgets = DEFAULT_BUDGETS["n2"]
        for budget in budgets:
            path = campaign / f"public/checkpoints/budget-{budget:04d}.json"
            if not path.is_file():
                raise ValueError(f"缺少 Population Checkpoint：{path}")
            checkpoint = _read_json(path)
            candidates.append(_population_candidate(
                mode=mode, campaign_root=campaign, checkpoint_path=path,
                checkpoint=checkpoint, budget_scope="total", budget_value=budget,
            ))
        if include_generations and mode != "single":
            generation_root = campaign / "public/checkpoints/branches"
            branch_paths = sorted(generation_root.glob("branch-*/generation-*.json"))
            if not branch_paths:
                raise ValueError(f"缺少 Branch Generation Checkpoint：{generation_root}")
            for path in branch_paths:
                branch_id = path.parent.name
                generation_text = path.stem.removeprefix("generation-")
                if not generation_text.isdigit() or int(generation_text) not in DEFAULT_GENERATIONS:
                    continue
                generation = int(generation_text)
                checkpoint = _read_json(path)
                candidates.append(_population_candidate(
                    mode=mode, campaign_root=campaign, checkpoint_path=path,
                    checkpoint=checkpoint, budget_scope="per-branch", budget_value=generation,
                    branch_generation=generation, branch_id=branch_id,
                ))
    return {
        "apiVersion": "harness-rsi/evaluation-manifest/v1",
        "kind": "BudgetAblationManifest",
        "description": "016 既有 Population Checkpoint 的 sealed-final 预算消融清单",
        "source": {
            "populationRoot": str(population_root),
            "prefix": prefix,
            "modes": list(modes),
        },
        "benchmark": {
            "partition": "sealed-final",
            "taskIds": [
                "officeval_011", "officeval_026", "officeval_033", "officeval_051",
                "officeval_070", "officeval_088", "officeval_089", "officeval_097",
            ],
        },
        "candidateIdentity": "branchId + candidateId + digest",
        "candidates": candidates,
    }


def tree_digest(root: Path) -> str:
    """与 controller/src/candidate.mjs 的 snapshotTree/treeDigest 保持一致。"""
    records: list[str] = []
    # Node 的 localeCompare（Controller 使用的排序）在默认 ICU locale 下将
    # 大小写按不区分大小写的顺序比较；用 lower+原文稳定复现该顺序。
    for path in sorted(
        root.rglob("*"),
        key=lambda p: (p.relative_to(root).as_posix().lower(), p.relative_to(root).as_posix()),
    ):
        rel = path.relative_to(root).as_posix()
        stat = path.lstat()
        if path.is_symlink() or (not path.is_dir() and not path.is_file()):
            raise ValueError(f"Candidate 包含符号链接或特殊文件：{path}")
        if path.is_dir():
            # snapshotTree 对目录固定记录 bytes=0（而非文件系统 st_size）。
            records.append("\0".join((rel, "directory", "", "0", "0")) + "\n")
        else:
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            executable = int(bool(stat.st_mode & 0o111))
            records.append("\0".join((rel, "file", digest, str(stat.st_size), str(executable))) + "\n")
    return hashlib.sha256("".join(records).encode()).hexdigest()


def validate_manifest(manifest: dict[str, Any], *, check_digest: bool = True) -> list[dict[str, Any]]:
    tasks = manifest.get("benchmark", {}).get("taskIds")
    if not isinstance(tasks, list) or not tasks or any(
        not isinstance(task, str) or not task or task in {".", ".."} or "/" in task or "\\" in task
        for task in tasks
    ) or len(set(tasks)) != len(tasks):
        raise ValueError("manifest taskIds 必须是非空、不重复的任务名清单")
    candidates = manifest.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        raise ValueError("manifest.candidates 不能为空")
    root = Path(manifest.get("source", {}).get("populationRoot", ""))
    if not root.is_dir():
        raise ValueError(f"manifest populationRoot 不存在：{root}")
    seen: dict[tuple[str, str, str], tuple[str, str]] = {}
    labels: set[str] = set()
    for record in candidates:
        record = _require_dict(record, "candidate")
        label = record.get("label")
        if not isinstance(label, str) or not label or label in {".", ".."} or "/" in label or "\\" in label or label in labels:
            raise ValueError("manifest label 必须是安全且不重复的目录名")
        labels.add(label)
        key = (str(record.get("branchId")), str(record.get("candidateId")), str(record.get("digest")))
        # 同一候选可能连续成为多个预算点的 Champion（例如 N2 的 B4/B8），
        # 允许重复引用，但必须指向同一 campaign/workspace，且 label 不能重复。
        location = (str(record.get("campaign")), str(record.get("workspace")))
        previous = seen.get(key)
        if previous is not None and previous != location:
            raise ValueError(f"同一 Candidate 身份指向多个 workspace：{key}")
        seen[key] = location
        workspace = Path(record.get("workspace", ""))
        if workspace.is_absolute() or ".." in workspace.parts:
            raise ValueError("manifest workspace 必须是安全的相对路径")
        campaign = record.get("campaign")
        if not isinstance(campaign, str) or not campaign or "/" in campaign or "\\" in campaign:
            raise ValueError("manifest campaign 必须是安全的相对目录名")
        path = root / campaign / str(workspace)
        if not path.is_dir():
            raise ValueError(f"Candidate workspace 不存在：{path}")
        if check_digest and tree_digest(path) != record["digest"]:
            raise ValueError(f"Candidate digest 不匹配：{record.get('label')} {path}")
    return candidates


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="构建并校验 Budget Ablation manifest")
    parser.add_argument("--population-root", type=Path, default=Path(os.environ.get("RSI_POPULATIONS_ROOT", "")))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--skip-generation", action="store_true")
    parser.add_argument("--no-digest-check", action="store_true")
    args = parser.parse_args()
    if not args.population_root:
        raise SystemExit("请设置 --population-root 或 RSI_POPULATIONS_ROOT")
    manifest = build_manifest(args.population_root, include_generations=not args.skip_generation)
    validate_manifest(manifest, check_digest=not args.no_digest_check)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"manifest={args.output} candidates={len(manifest['candidates'])}")


if __name__ == "__main__":
    main()
