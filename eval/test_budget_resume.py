"""逐题续跑的行为测试，无模型请求、无 Docker、无历史实验依赖。"""

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import run_budget_ablation as runner
from budget_results import atomic_json, summarize


class BudgetResumeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.record = dict(label="single-b02", mode="single", budgetScope="total", budget=2,
                           populationBudget=2, branchId="branch-001", candidateId="g002-l3",
                           digest="a" * 64, revision="a" * 64, checkpoint="budget-0002.json",
                           campaign="original", workspace="candidates/g002-l3/workspace")
        self.tasks = ["zero", "negative", "failed"]
        self.manifest = {"source": {"populationRoot": "unused"}, "benchmark": {"taskIds": self.tasks}}
        self.target = self.root / self.record["label"] / "candidate_summary.json"
        self.rows = {"zero": self.row("zero", 0), "negative": self.row("negative", -0.5),
                     "failed": self.row("failed", 0, "HTTP 502")}
        self.base = SimpleNamespace(run_one_task=Mock(return_value=self.row("failed", 1)))
        self.copy = patch.object(runner, "_copy_candidate", return_value=self.root / "candidate")
        self.mock_copy = self.copy.start()
        self.addCleanup(self.copy.stop)

    @staticmethod
    def row(task, reward, error=None):
        return {"task": task, "reward": reward, "error": error}

    def save(self, rows=None, legacy=False):
        data = summarize(self.record, self.tasks, self.rows if rows is None else rows, [])
        if legacy:
            for key in ("campaign", "workspace", "taskIds", "attempt_history", "missing_tasks"):
                data.pop(key)
        atomic_json(self.target, data)

    def run_record(self):
        return runner._run_record(self.record, self.manifest, self.root, self.root / "scratch", self.base)

    def test_legacy_reuses_zero_and_negative_only_retries_failure(self):
        self.save(legacy=True)
        old = self.target.parent / "failed"
        old.mkdir()
        (old / "trace").write_text("原失败轨迹")
        result = self.run_record()
        self.assertEqual(self.base.run_one_task.call_count, 1)
        self.assertEqual(self.base.run_one_task.call_args.args[1], "failed")
        self.assertEqual(result["tasks"][:2], [self.rows["zero"], self.rows["negative"]])
        self.assertEqual(result["mean_reward"], 0.166667)
        history = result["attempt_history"][0]
        self.assertEqual(history["result"]["error"], "HTTP 502")
        self.assertEqual((self.root / history["artifacts"] / "trace").read_text(), "原失败轨迹")

    def test_complete_skips_candidate_materialization(self):
        self.rows["failed"] = self.row("failed", 1)
        self.save()
        self.assertEqual(self.run_record()["status"], "complete")
        self.base.run_one_task.assert_not_called()
        self.mock_copy.assert_not_called()

    def test_identity_mismatch_rejected_before_copy_or_execution(self):
        self.save()
        self.record["digest"] = "b" * 64
        with self.assertRaisesRegex(ValueError, "候选身份不符"):
            self.run_record()
        self.mock_copy.assert_not_called()

    def test_changed_task_list_rejected(self):
        self.save()
        self.manifest["benchmark"]["taskIds"] = ["different"]
        with self.assertRaisesRegex(ValueError, "任务清单不符"):
            self.run_record()

    def test_missing_tasks_are_executed(self):
        self.save({k: v for k, v in self.rows.items() if k != "failed"})
        self.assertEqual(self.run_record()["tasks_completed"], 3)
        self.assertEqual(self.base.run_one_task.call_count, 1)

    def test_failed_retry_still_has_no_official_mean(self):
        self.save()
        self.base.run_one_task.side_effect = RuntimeError("still unavailable")
        result = self.run_record()
        self.assertIsNone(result["mean_reward"])
        self.assertEqual(result["partial_mean_of_completed"], -0.25)
        self.assertEqual(result["tasks_completed"], 2)

    def test_interruption_saves_prior_task_and_resume_skips_it(self):
        self.base.run_one_task.side_effect = [self.row("zero", 0), KeyboardInterrupt()]
        with self.assertRaises(KeyboardInterrupt):
            self.run_record()
        saved = json.loads(self.target.read_text())
        self.assertEqual(saved["tasks_completed"], 1)
        self.assertIsNone(saved["mean_reward"])
        self.base.run_one_task.reset_mock()
        self.base.run_one_task.side_effect = [self.row("negative", -0.5), self.row("failed", 1)]
        self.assertEqual(self.run_record()["status"], "complete")
        self.assertEqual([call.args[1] for call in self.base.run_one_task.call_args_list], ["negative", "failed"])

    def test_corrupt_progress_does_not_silently_restart(self):
        self.target.parent.mkdir(parents=True)
        self.target.write_text("{broken")
        with self.assertRaises(json.JSONDecodeError):
            self.run_record()
        self.mock_copy.assert_not_called()


if __name__ == "__main__":
    unittest.main()
