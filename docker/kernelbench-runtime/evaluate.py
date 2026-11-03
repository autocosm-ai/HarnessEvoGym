"""原始 KernelBench 任务的独立评分入口；编译和预热不计入性能时间。"""
import gc
import importlib.util
import json
import math
from pathlib import Path
import statistics
import sys

import torch


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def clone(value, device=None):
    if isinstance(value, torch.Tensor):
        return value.detach().clone().to(device or value.device)
    if isinstance(value, (tuple, list)):
        return type(value)(clone(item, device) for item in value)
    if isinstance(value, dict):
        return {key: clone(item, device) for key, item in value.items()}
    return value


def assert_same(actual, expected, *, exact=False):
    if isinstance(expected, torch.Tensor):
        if not isinstance(actual, torch.Tensor) or actual.device != expected.device:
            raise AssertionError("output type or device differs")
        torch.testing.assert_close(actual, expected, rtol=0 if exact else 1e-4, atol=0 if exact else 1e-4,
                                   equal_nan=False, check_dtype=True)
    elif isinstance(expected, (tuple, list)):
        if type(actual) is not type(expected) or len(actual) != len(expected):
            raise AssertionError("output structure differs")
        for left, right in zip(actual, expected):
            assert_same(left, right, exact=exact)
    elif actual != expected:
        raise AssertionError("non-tensor input/output changed")


def measure(model, args, repetitions=10):
    for _ in range(3):
        model(*args)
    torch.cuda.synchronize()
    start, end = (torch.cuda.Event(enable_timing=True) for _ in range(2))
    start.record()
    for _ in range(repetitions):
        model(*args)
    end.record()
    end.synchronize()
    value = start.elapsed_time(end) / repetitions
    if not math.isfinite(value) or value <= 0:
        raise RuntimeError("invalid CUDA timing")
    return value


def report(reward, error=None, metrics=None):
    root = Path("/logs/verifier")
    root.mkdir(parents=True, exist_ok=True)
    passed = error is None
    (root / "reward.txt").write_text(f"{reward:.8f}\n")
    (root / "ctrf.json").write_text(json.dumps({
        "results": {"summary": {"tests": 1, "passed": int(passed), "failed": int(not passed),
                                  "skipped": 0, "pending": 0, "other": 0},
                    "tests": [{"name": "kernel-correctness-and-speed", "status": "passed" if passed else "failed",
                               "message": error or ""}]},
        "metrics": metrics or {},
    }, allow_nan=False))


def main():
    if not torch.cuda.is_available():
        raise RuntimeError("verifier requires CUDA")
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False
    reference = load("/tests/reference.py", "kernelbench_reference")
    torch.manual_seed(71)
    reference_model = reference.Model(*reference.get_init_inputs()).cuda().eval()
    # 先独立确认参考任务可运行；这里失败属于环境错误，退出非零。
    args = clone(reference.get_inputs(), "cuda")
    with torch.inference_mode():
        reference_model(*args)
        reference_ms = measure(reference_model, args)
    del args
    gc.collect()
    torch.cuda.empty_cache()
    try:
        torch.manual_seed(71)
        candidate = load(sys.argv[1], "kernelbench_candidate")
        candidate_model = candidate.ModelNew(*reference.get_init_inputs()).cuda().eval()
        candidate_model.load_state_dict(reference_model.state_dict(), strict=False)
        with torch.inference_mode():
            for seed in (71, 113, 197):
                torch.manual_seed(seed)
                args = clone(reference.get_inputs(), "cuda")
                expected = reference_model(*args)
                before = clone(args)
                actual = candidate_model(*args)
                torch.cuda.synchronize()
                assert_same(actual, expected)
                assert_same(args, before, exact=True)
                del args, before, expected, actual
                gc.collect()
                torch.cuda.empty_cache()
            torch.manual_seed(311)
            args = clone(reference.get_inputs(), "cuda")
            # 交替测量五轮，取中位数，保留重复次数和原始速度比。
            references, candidates = [], []
            for index in range(5):
                order = [(reference_model, references), (candidate_model, candidates)]
                if index % 2:
                    order.reverse()
                for model, measurements in order:
                    measurements.append(measure(model, args))
            reference_ms = statistics.median(references)
            candidate_ms = statistics.median(candidates)
            speedup = reference_ms / candidate_ms
            if not math.isfinite(speedup) or speedup <= 0:
                raise ValueError("invalid speedup")
    except Exception as error:
        message = str(error)
        report(0, f"Candidate {type(error).__name__}: {message[:600]}\n{message[-1600:] if len(message) > 600 else ''}")
        return
    report(speedup / (1 + speedup), metrics={"reference_ms": reference_ms,
           "candidate_ms": candidate_ms, "speedup": speedup, "correctness_trials": 3, "timing_rounds": 5})


if __name__ == "__main__":
    main()
