"""使用临时输入和假 Docker 跑完整调度，不调用付费 API，不依赖历史实验。"""

import collections
import contextlib
import io
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import run_eval
from eval_config import load_config
from eval_results import output_session
from eval_runtime import verifier_reward


class EvalRunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.tasks = ["officeval_001", "officeval_002"]
        self.dataset = self.root / "dataset"
        self.evaluator = self.root / "evaluator"
        (self.dataset / "tasks").mkdir(parents=True)
        (self.evaluator / "verifiers").mkdir(parents=True)
        for task in self.tasks:
            (self.dataset / "tasks" / f"{task}.json").write_text(json.dumps({"instruction": "solve fixture"}))
            files = self.dataset / "task_files" / task
            files.mkdir(parents=True)
            (files / "input.txt").write_text("original")
            (self.evaluator / "verifiers" / f"{task}_verifier.py").write_text("# fixture")
        for mode in ("h0", "single"):
            candidate = self.root / mode
            candidate.mkdir()
            (candidate / "run.py").write_text("# frozen runner")
            (candidate / "model.py").write_text("# frozen model")
        self.config_path = self.root / "config.json"
        self.raw = {
            "version": 1, "tasks": self.tasks,
            "candidates": {name: {"workspace": name} for name in ("h0", "single")},
            "solver": {"model": "fixture-model", "image": "fixture:v1", "max_steps": 3,
                       "max_output_tokens": 123, "task_timeout_seconds": 7},
        }
        self.write_config()
        self.env = patch.dict(os.environ, {
            "RSI_OFFICEVAL_DATASET_ROOT": str(self.dataset),
            "RSI_OFFICEVAL_EVALUATOR_ROOT": str(self.evaluator),
            "RSI_PROVIDER_API_KEY": "fixture-only-key",
            "RSI_PROVIDER_BASE_URL": "https://example.invalid/v1",
            "RSI_RUN_VERIFIER": "", "RSI_SOLVER_IMAGE": "",
        })
        self.env.start()
        self.addCleanup(self.env.stop)
        self.out = self.root / "results"
        self.calls = collections.Counter()
        self.fail = True

    def write_config(self):
        self.config_path.write_text(json.dumps(self.raw))

    def invoke(self, *extra):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return run_eval.main(["--config", str(self.config_path), "--out", str(self.out), *extra])

    def docker(self, args, **kwargs):
        if args[:3] == ["docker", "image", "inspect"]:
            return subprocess.CompletedProcess(args, 0, "sha256:" + "a" * 64, "")
        mounts = {}
        for index, arg in enumerate(args):
            if arg == "-v":
                source, target, *_ = args[index + 1].split(":")
                mounts[target] = Path(source)
        if "/candidate/run.py" in args:
            self.assertNotIn("fixture-only-key", " ".join(args))
            self.assertEqual(kwargs["env"]["RSI_MODEL_GATEWAY_DUMMY_KEY"], "fixture-only-key")
            self.assertIn("RSI_MODEL_GATEWAY_MODEL=fixture-model", args)
            self.assertEqual(kwargs["timeout"], 7)
            self.assertIn("RSI_MODEL_GATEWAY_MAX_TOKENS=123", args)
            workspace = mounts["/workspace"]
            mode, task = workspace.relative_to(self.out).parts[:2]
            self.calls[(mode, task)] += 1
            self.assertTrue(mounts["/candidate"].is_relative_to(self.out))
            (workspace / "answer.txt").write_text("answer")
            if self.fail and (mode, task) == ("single", self.tasks[1]):
                return subprocess.CompletedProcess(args, 1, "", "provider temporarily unavailable")
        elif "/run-verifier.py" in args:
            self.assertIn("/run-verifier.py", mounts)
            self.assertEqual(args[args.index("--network") + 1], "none")
            task = args[args.index("--expected-id") + 1]
            (mounts["/out"] / "verifier_result.json").write_text(json.dumps({
                "id": task, "status": "ok", "total_score": 1, "max_score": 2,
            }))
        else:
            self.assertIn("chown", args)
        return subprocess.CompletedProcess(args, 0, "", "")

    def test_resume_only_failed_tasks_and_preserves_sources(self):
        with patch("subprocess.run", side_effect=self.docker):
            self.assertEqual(self.invoke(), 2)
            report = json.loads((self.out / "summary.json").read_text())
            self.assertIsNone(report["modes"]["single"]["mean_reward"])
            self.assertEqual(report["modes"]["h0"]["mean_reward"], 0.5)
            self.fail = False
            self.assertEqual(self.invoke("--resume"), 0)
            self.assertEqual(self.calls[("single", self.tasks[1])], 2)
            self.assertTrue(all(count == 1 for key, count in self.calls.items()
                                if key != ("single", self.tasks[1])))
            previous = self.calls.copy()
            self.assertEqual(self.invoke("--resume"), 0)
            self.assertEqual(self.calls, previous)
            self.assertEqual(self.invoke(), 2)
            (self.dataset / "task_files" / self.tasks[0] / "input.txt").write_text("changed")
            self.assertEqual(self.invoke("--resume"), 2)
            self.assertEqual(self.calls, previous)
        for mode in ("h0", "single"):
            self.assertEqual((self.root / mode / "model.py").read_text(), "# frozen model")
        self.assertEqual((self.dataset / "task_files" / self.tasks[1] / "input.txt").read_text(), "original")

    def test_dry_run_needs_no_key_or_docker_and_does_not_write(self):
        with patch.dict(os.environ, {"RSI_PROVIDER_API_KEY": "", "RSI_PROVIDER_BASE_URL": ""}), patch("subprocess.run") as docker:
            self.assertEqual(self.invoke("--dry-run"), 0)
            docker.assert_not_called()
        self.assertFalse(self.out.exists())

    def test_configuration_and_path_validation(self):
        for change in ({"tasks": self.tasks * 2}, {"solver": {**self.raw["solver"], "max_steps": True}}):
            original = self.raw.copy()
            self.raw.update(change)
            self.write_config()
            with self.assertRaises(ValueError):
                load_config(self.config_path)
            self.raw = original
        self.write_config()
        with patch("subprocess.run") as docker:
            self.assertEqual(self.invoke("--modes", "../h0"), 2)
            self.assertEqual(self.invoke("--modes", "h0", "h0"), 2)
            self.assertEqual(self.invoke("--concurrency", "0"), 2)
            self.assertEqual(self.invoke("--out", str(self.dataset / "outputs")), 2)
            docker.assert_not_called()

    def test_best_report_resolves_without_original_machine_path(self):
        report = self.root / "population/report/best-harness.json"
        report.parent.mkdir(parents=True)
        report.write_text(json.dumps({
            "kind": "BestHarnessImplementation", "branchId": "branch-002",
            "candidateId": "g008-l3", "workspace": "/old-machine/not-used",
        }))
        self.raw["candidates"] = {"winner": {"best_report": "population/report/best-harness.json"}}
        self.write_config()
        candidate = load_config(self.config_path)["candidates"]["winner"]
        self.assertEqual(candidate, self.root / "population/branches/branch-002/run/candidates/g008-l3/workspace")

    def test_model_change_prevents_score_reuse(self):
        self.fail = False
        with patch("subprocess.run", side_effect=self.docker):
            self.assertEqual(self.invoke(), 0)
            self.raw["solver"]["model"] = "different-model"
            self.write_config()
            self.assertEqual(self.invoke("--resume"), 2)

    def test_output_lock_rejects_concurrent_writers(self):
        with output_session(self.out, {"fingerprint": "fixture"}, False):
            with self.assertRaisesRegex(ValueError, "已有评测进程"):
                with output_session(self.out, {"fingerprint": "fixture"}, True):
                    self.fail("不应拿到同一目录的第二把锁")

    def test_verifier_invalid_fields_do_not_become_zero(self):
        base = {"id": "officeval_001", "status": "ok", "total_score": -1, "max_score": 2}
        self.assertEqual(verifier_reward(base, "officeval_001"), -0.5)
        for delta in ({"max_score": 0}, {"total_score": None}, {"total_score": float("nan")},
                      {"max_score": True}, {"id": "wrong"}, {"status": "unknown"}):
            with self.subTest(delta=delta), self.assertRaises(ValueError):
                verifier_reward({**base, **delta}, "officeval_001")


if __name__ == "__main__":
    unittest.main()
