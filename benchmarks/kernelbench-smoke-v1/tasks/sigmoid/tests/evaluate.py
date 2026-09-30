import importlib.util
import json
import sys

import torch


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    if not torch.cuda.is_available():
        raise RuntimeError("KernelBench verifier requires CUDA")
    reference = load("/tests/reference.py", "reference")
    candidate = load(sys.argv[1], "candidate")
    device = torch.device("cuda:0")
    reference_model = reference.Model(*reference.get_init_inputs()).to(device).eval()
    candidate_model = candidate.ModelNew(*reference.get_init_inputs()).to(device).eval()
    inputs = [value.to(device) if hasattr(value, "to") else value for value in reference.get_inputs()]
    with torch.inference_mode():
        expected = reference_model(*inputs)
        for _ in range(3):
            actual = candidate_model(*inputs)
            torch.testing.assert_close(actual, expected, rtol=1e-4, atol=1e-4)
    def measure(model):
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
            return start.elapsed_time(end) / 30.0
    reference_ms = measure(reference_model)
    candidate_ms = measure(candidate_model)
    speedup = reference_ms / max(candidate_ms, 1e-9)
    reward = min(1.0, max(0.0, speedup))
    with open("/logs/verifier/reward.txt", "w", encoding="utf-8") as handle:
        handle.write(f"{reward:.6f}\n")
    with open("/logs/verifier/ctrf.json", "w", encoding="utf-8") as handle:
        # Harbor 只接收受限 CTRF 摘要；性能细节放在同一个结果对象的
        # metrics 字段，避免把自定义摘要误当成 CTRF 而被拒绝。
        json.dump({
            "results": {
                "summary": {"tests": 1, "passed": 1, "failed": 0, "skipped": 0, "pending": 0, "other": 0},
                "tests": [{"name": "correctness-and-speed", "status": "passed"}],
            },
            "metrics": {"reference_ms": reference_ms, "candidate_ms": candidate_ms, "speedup": speedup},
        }, handle)


if __name__ == "__main__":
    main()
