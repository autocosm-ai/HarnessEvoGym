"""验证 run_eval.py 的不完整结果处理：注入一个失败题，确认真实代码拒绝出正式均值。"""
import importlib.util, json, os, sys, tempfile
from pathlib import Path

ROOT = ("/data/workspace/liuzhou/projs/01-code-apps/项目-Deepseek-Harness-RSI/002-Code"
        "/.claude/worktrees/017-robust-final-eval")

os.environ.update({
    "RSI_PROVIDER_API_KEY": "dummy",
    "RSI_PROVIDER_BASE_URL": "https://example.invalid/v1",
    "RSI_OFFICEVAL_DATASET_ROOT": "/data/workspace/liuzhou/projs/01-code-apps/项目-Cowork-Evolution-Benchmark/003-Reference/002-Reference-Code/OmegaUse-OfficeVal-Dataset",
    "RSI_OFFICEVAL_EVALUATOR_ROOT": "/data/workspace/liuzhou/projs/01-code-apps/项目-Cowork-Evolution-Benchmark/003-Reference/002-Reference-Code/OmegaUse-OfficeVal",
})

spec = importlib.util.spec_from_file_location("re_mod", f"{ROOT}/eval/run_eval.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

TASKS = mod.FINAL_TASK_IDS

def fake_run_mode(mode, out_dir, scratch_root):
    """h0 全部成功；single 第 3 题失败；其余全部成功。"""
    rows = []
    for i, t in enumerate(TASKS):
        if mode == "single" and i == 2:
            rows.append({"task": t, "reward": 0.0, "error": "timeout 3600s"})
        else:
            rows.append({"task": t, "reward": 0.5, "error": None})
    return rows

mod.run_mode = fake_run_mode

tmp = Path(tempfile.mkdtemp())
sys.argv = ["run_eval.py", "--modes", "h0", "single", "--concurrency", "2", "--out", str(tmp)]

print("--- 运行 main() ---")
mod.main()

print("\n--- 校验 summary.json ---")
d = json.loads((tmp / "summary.json").read_text())
fails = []
def check(name, got, want):
    ok = got == want
    print(f"  {'PASS' if ok else 'FAIL'}  {name}: got={got!r} want={want!r}")
    if not ok: fails.append(name)

check("run_complete", d["run_complete"], False)
check("incomplete_modes", d["incomplete_modes"], ["single"])
check("h0.status", d["modes"]["h0"]["status"], "complete")
check("h0.mean_reward", d["modes"]["h0"]["mean_reward"], 0.5)
check("single.status", d["modes"]["single"]["status"], "incomplete")
check("single.mean_reward IS None", d["modes"]["single"]["mean_reward"], None)
check("single.tasks_completed", d["modes"]["single"]["tasks_completed"], 7)
check("single.failed_tasks", d["modes"]["single"]["failed_tasks"], [TASKS[2]])
# 部分均值只统计完成题：7 题 x 0.5 / 7 = 0.5（不被失败的 0 稀释）
check("single.partial_mean", d["modes"]["single"]["partial_mean_of_completed"], 0.5)

print()
if fails:
    print(f"FAILED: {fails}"); sys.exit(1)
print("all checks passed — 失败题不会被当成 0 分计入分数")
