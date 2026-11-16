"""Tests for export_evals.py against the three-row fixture in testdata/.

Run from anywhere (python3 -I keeps the cwd off sys.path, so run the file directly):
    python3 -I benchmarks/uc2/test_export_evals.py -v
"""

import csv
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import export_evals  # noqa: E402

REPO_ROOT = HERE.parents[1]
FIXTURE_CSV = HERE / "testdata" / "sessions.sample.csv"
FIXTURE_MANIFEST = HERE / "testdata" / "manifest.json"

REQUIRED_SPAN = [
    "circleci.eval.suite", "circleci.eval.task", "circleci.eval.trial", "circleci.eval.run_id",
    "circleci.eval.polarity", "circleci.eval.sut.name", "circleci.eval.sut.version",
    "circleci.eval.harness.name", "circleci.eval.harness.version",
    "gen_ai.operation.name", "gen_ai.provider.name", "gen_ai.request.model",
    "gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens",
    "circleci.eval.turns", "circleci.eval.tool_calls",
]
REQUIRED_EVENT = [
    "gen_ai.evaluation.name", "gen_ai.evaluation.score.label", "circleci.eval.grader.kind",
    "circleci.eval.grader.model",
    "circleci.eval.suite", "circleci.eval.task", "circleci.eval.trial", "circleci.eval.run_id",
]


class ExportEvalsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="uc2-export-test-"))
        run_dir = cls.tmp / "run"
        run_dir.mkdir()
        shutil.copy(FIXTURE_CSV, run_dir / "sessions.csv")
        shutil.copy(FIXTURE_MANIFEST, run_dir / "manifest.json")
        cls.out = cls.tmp / "out.jsonl"
        cls.count = export_evals.export(run_dir, cls.out, repo_root=REPO_ROOT)
        with cls.out.open(encoding="utf-8") as fh:
            cls.records = [json.loads(line) for line in fh]
        with FIXTURE_CSV.open(newline="", encoding="utf-8") as fh:
            cls.rows = list(csv.DictReader(fh))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_record_count_matches_rows(self):
        self.assertEqual(len(self.rows), 3)
        self.assertEqual(self.count, 3)
        self.assertEqual(len(self.records), 3)
        for rec in self.records:
            self.assertEqual(rec["name"], "eval.trial")
            self.assertEqual(len(rec["events"]), 1, "one rubric_score verdict per row")

    def test_required_attributes_present(self):
        for rec in self.records:
            for key in REQUIRED_SPAN:
                self.assertIn(key, rec["span"], key)
                self.assertNotEqual(rec["span"][key], "", key)
            ev = rec["events"][0]
            for key in REQUIRED_EVENT:
                self.assertIn(key, ev, key)
            self.assertEqual(ev["gen_ai.evaluation.name"], "rubric_score")
            self.assertEqual(ev["circleci.eval.grader.kind"], "model")
            self.assertIn("circleci.eval.grader.calibration", ev)
            self.assertTrue(ev["circleci.eval.grader.version"].startswith("uc2-judge@"))
            for key in ("circleci.eval.suite", "circleci.eval.task", "circleci.eval.trial", "circleci.eval.run_id"):
                self.assertEqual(ev[key], rec["span"][key])

    def test_no_transcript_text_in_trial_span(self):
        for row, rec in zip(self.rows, self.records):
            span_json = json.dumps(rec["span"])
            for col in ("finalAnswer", "judgeReasoning"):
                text = row[col].strip()
                if text:
                    self.assertNotIn(text[:60], span_json, f"{col} leaked into span")
            self.assertNotIn("finalAnswer", rec["span"])
            self.assertNotIn("judgeReasoning", rec["span"])
            self.assertEqual(rec["span"]["circleci.eval.transcript.url"], row["transcriptPath"])

    def test_types_and_fixed_values(self):
        for rec in self.records:
            span = rec["span"]
            self.assertEqual(span["circleci.eval.suite"], "uc2")
            self.assertEqual(span["circleci.eval.harness.name"], "uc2")
            self.assertTrue(span["circleci.eval.harness.version"].startswith("product-benchmarking@"))
            self.assertEqual(span["circleci.eval.polarity"], "positive")
            self.assertEqual(span["circleci.eval.use_case"], span["circleci.eval.task"])
            self.assertIsInstance(span["circleci.eval.trial"], int)
            self.assertIsInstance(span["gen_ai.usage.input_tokens"], int)
            self.assertIsInstance(span["circleci.eval.cost_usd"], float)
            for key, value in span.items():
                if key.startswith("circleci.eval.metric."):
                    self.assertIsInstance(value, float, key)

    def test_sut_name_follows_condition(self):
        for row, rec in zip(self.rows, self.records):
            expected = "circleci-cli" if row["condition"].startswith("cli") else "hosted-mcp"
            self.assertEqual(rec["span"]["circleci.eval.sut.name"], expected)

    def test_verdict_labels(self):
        by_case = {rec["span"]["circleci.eval.task"]: rec for rec in self.records}
        fail = by_case["diagnose-failed-build"]["events"][0]
        self.assertEqual(fail["gen_ai.evaluation.score.label"], "fail")
        self.assertEqual(fail["gen_ai.evaluation.score.value"], 1.0)
        self.assertLessEqual(len(fail["gen_ai.evaluation.explanation"].encode("utf-8")), 2048)

        ok = by_case["find-flaky-tests"]["events"][0]
        self.assertEqual(ok["gen_ai.evaluation.score.label"], "pass")
        self.assertGreaterEqual(ok["gen_ai.evaluation.score.value"], 4.0)
        self.assertEqual(by_case["find-flaky-tests"]["span"]["circleci.eval.metric.skills_loaded"], 1.0)

        err_rec = by_case["compare-test-results-branches"]
        err = err_rec["events"][0]
        self.assertEqual(err["gen_ai.evaluation.score.label"], "skipped")
        self.assertNotIn("gen_ai.evaluation.score.value", err)
        self.assertEqual(err_rec["span"]["error.type"], "provider_error")
        self.assertEqual(err_rec["span"]["circleci.eval.outcome"], "error")

    def test_truncate_utf8_does_not_split_code_points(self):
        text = "é" * 2000  # 4000 bytes
        cut = export_evals.truncate_utf8(text, 2048)
        self.assertLessEqual(len(cut.encode("utf-8")), 2048)
        self.assertEqual(cut, "é" * 1024)


if __name__ == "__main__":
    unittest.main()
