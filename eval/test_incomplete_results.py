"""不完整结果必须保持 incomplete，不能把缺失、重复或非法分数当成正常结果。"""

import unittest

from eval_results import mode_stats
from run_eval import make_report


class IncompleteResultsTests(unittest.TestCase):
    tasks = ["officeval_001", "officeval_002"]

    def rows(self):
        return [{"task": task, "reward": 0.5, "error": None} for task in self.tasks]

    def test_complete_and_negative_rewards(self):
        rows = self.rows()
        rows[0]["reward"] = -0.5
        result = mode_stats(rows, self.tasks)
        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["mean_reward"], 0.0)

    def test_failed_task_has_no_official_score(self):
        rows = self.rows()
        rows[1].update(reward=0.0, error="timeout")
        report = make_report({"h0": self.rows(), "single": rows}, ["h0", "single"], self.tasks)
        self.assertFalse(report["run_complete"])
        self.assertEqual(report["incomplete_modes"], ["single"])
        self.assertEqual(report["modes"]["h0"]["mean_reward"], 0.5)
        single = report["modes"]["single"]
        self.assertIsNone(single["mean_reward"])
        self.assertEqual(single["partial_mean_of_completed"], 0.5)
        self.assertEqual(single["tasks_completed"], 1)
        self.assertEqual(single["tasks_total"], 2)
        self.assertEqual(single["failed_tasks"], [self.tasks[1]])

    def test_missing_duplicate_and_extra_tasks(self):
        for rows in ([], self.rows()[:1], [self.rows()[0]] * 2,
                     self.rows() + [{"task": "unexpected", "reward": 1, "error": None}]):
            with self.subTest(rows=rows):
                result = mode_stats(rows, self.tasks)
                self.assertEqual(result["status"], "incomplete")
                self.assertIsNone(result["mean_reward"])
                self.assertEqual(result["tasks_total"], 2)

    def test_invalid_scores_cannot_be_completed(self):
        for invalid in (float("nan"), float("inf"), True, None, "0.5"):
            rows = self.rows()
            rows[0]["reward"] = invalid
            with self.subTest(invalid=invalid):
                self.assertIsNone(mode_stats(rows, self.tasks)["mean_reward"])


if __name__ == "__main__":
    unittest.main()
