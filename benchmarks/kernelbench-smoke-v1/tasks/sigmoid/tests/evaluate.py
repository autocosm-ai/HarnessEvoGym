"""KernelBench smoke：先验证数值，再比较速度；候选错误不能冒充基础设施故障。"""
import importlib.util
import json
import math
import sys

import torch


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def speedup_reward(speedup):
    # 单调压到 [0, 1)，基线约为 0.5；两倍加速约为 0.667，不在一倍处封顶。
    if not math.isfinite(speedup) or speedup <= 0:
        raise ValueError("speedup must be positive and finite")
    return speedup / (1.0 + speedup)


def report(reward, status, message="", metrics=None):
    passed = status == "passed"
    with open("/logs/verifier/reward.txt", "w", encoding="utf-8") as handle:
        handle.write(f"{reward:.6f}\n")
    with open("/logs/verifier/ctrf.json", "w", encoding="utf-8") as handle:
        json.dump({
            "results": {
                "summary": {"tests": 1, "passed": int(passed), "failed": int(not passed),
                            "skipped": 0, "pending": 0, "other": 0},
                "tests": [{"name": "correctness-and-speed", "status": status, "message": message}],
            },
            "metrics": metrics or {},
        }, handle, allow_nan=False)


def measure(model, inputs):
    with torch.inference_mode():
        for _ in range(10):
            model(*inputs)
        torch.cuda.synchronize()
        start = torch.cuda.Event(enable_timing=True)
        end = torch.cuda.Event(enable_timing=True)
        start.record()
        for _ in range(30):
            model(*inputs)
        end.record()
        end.synchronize()
        elapsed = start.elapsed_time(end) / 30.0
        if not math.isfinite(elapsed) or elapsed <= 0:
            raise RuntimeError("invalid CUDA timing")
        return elapsed


def main():
    # 可信环境和参考实现先自检。这里失败必须退出非零，由 Controller 处理基础设施错误。
    if not torch.cuda.is_available():
        raise RuntimeError("KernelBench verifier requires CUDA")
    reference = load("/tests/reference.py", "reference")
    device = torch.device("cuda:0")
    reference_model = reference.Model(*reference.get_init_inputs()).to(device).eval()
    cases = []
    with torch.inference_mode():
        for seed in (71, 113, 197):
            torch.manual_seed(seed)
            inputs = [v.to(device) if hasattr(v, "to") else v for v in reference.get_inputs()]
            expected = reference_model(*inputs)
            cases.append((inputs, expected.clone()))
    reference_ms = measure(reference_model, cases[0][0])

    # 候选加载、构造、计算或正确性失败属于候选零分，不应整题无限重试。
    try:
        candidate = load(sys.argv[1], "candidate")
        candidate_model = candidate.ModelNew(*reference.get_init_inputs()).to(device).eval()
        with torch.inference_mode():
            for inputs, expected in cases:
                independent = [v.clone() if isinstance(v, torch.Tensor) else v for v in inputs]
                actual = candidate_model(*independent)
                torch.testing.assert_close(actual, expected, rtol=1e-4, atol=1e-4)
                for before, after in zip(inputs, independent):
                    if isinstance(before, torch.Tensor):
                        torch.testing.assert_close(after, before, rtol=0, atol=0)
        candidate_ms = measure(candidate_model, [v.clone() for v in cases[0][0]])
        speedup = reference_ms / candidate_ms
        reward = speedup_reward(speedup)
    except Exception as error:
        report(0.0, "failed", f"Candidate {type(error).__name__}: {str(error)[:400]}")
        return

    report(reward, "passed", metrics={
        "reference_ms": reference_ms, "candidate_ms": candidate_ms,
        "speedup": speedup, "correctness_trials": len(cases),
    })


if __name__ == "__main__":
    main()
