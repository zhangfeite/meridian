import json
import importlib.util
import io
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

from meridian_bench.adapters import AdapterError, HttpAdapter, SubprocessAdapter
from meridian_bench.cli import main
from meridian_bench.tasks import load_tasks


BENCH_DIR = Path(__file__).resolve().parents[2]
RUNNER_DIR = BENCH_DIR / "runner"
TASKS_DIR = BENCH_DIR / "tasks"
FAKE_AGENT = RUNNER_DIR / "tests" / "fake_agent.py"
EMPTY_AGENT = RUNNER_DIR / "tests" / "empty_agent.py"
DEEPSEEK_AGENT = BENCH_DIR / "baselines" / "deepseek_agent.py"
REPO_ROOT = BENCH_DIR.parents[1]


class _FakeResponse:
    def __init__(self, payload):
        self.payload = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self):
        return self.payload


class AdapterAndCliTests(unittest.TestCase):
    def test_http_adapter(self):
        requests = []

        def fake_urlopen(request, timeout):
            requests.append(json.loads(request.data.decode("utf-8")))
            return _FakeResponse({"output": "HTTP answer"})

        with mock.patch("meridian_bench.adapters.urllib.request.urlopen", side_effect=fake_urlopen):
            result = HttpAdapter("http://agent.test/answer", timeout=2, retries=0).run({"prompt": "p", "task_id": "T"})
        self.assertEqual(result.output, "HTTP answer")
        self.assertEqual(requests[0]["prompt"], "p")

    def test_subprocess_adapter(self):
        adapter = SubprocessAdapter("%s %s" % (sys.executable, FAKE_AGENT), timeout=2, retries=0)
        result = adapter.run({"prompt": "p", "task_id": "MB-X", "lang": "en", "type": "fact_extraction"})
        self.assertEqual(result.output, "fake response for MB-X")

    def test_subprocess_relative_path_is_anchored_to_calling_cwd(self):
        relative_agent = FAKE_AGENT.relative_to(REPO_ROOT)
        adapter = SubprocessAdapter(
            "%s %s" % (sys.executable, relative_agent),
            timeout=2,
            retries=0,
            cwd=REPO_ROOT,
        )
        result = adapter.run({"prompt": "p", "task_id": "MB-X", "lang": "en", "type": "fact_extraction"})
        self.assertEqual(result.output, "fake response for MB-X")

    def test_subprocess_error_reports_cwd_and_resolved_path(self):
        missing = Path("meridian/bench/baselines/missing_agent.py")
        adapter = SubprocessAdapter("%s %s" % (sys.executable, missing), retries=0, cwd=REPO_ROOT)
        with self.assertRaises(AdapterError) as raised:
            adapter.run({"prompt": "p"})
        message = str(raised.exception)
        self.assertIn("cwd=%s" % REPO_ROOT, message)
        self.assertIn(str((REPO_ROOT / missing).resolve()), message)

    def test_deepseek_client_against_fake_chat_server(self):
        spec = importlib.util.spec_from_file_location("deepseek_baseline_for_test", DEEPSEEK_AGENT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        requests = []

        def fake_urlopen(request, timeout):
            requests.append(json.loads(request.data.decode("utf-8")))
            return _FakeResponse({"choices": [{"message": {"content": "model answer"}}]})

        stdout = io.StringIO()
        with mock.patch.object(sys, "stdin", io.StringIO(json.dumps({"prompt": "financial prompt"}))):
            with mock.patch.object(module.urllib.request, "urlopen", side_effect=fake_urlopen):
                with mock.patch.dict(os.environ, {"DEEPSEEK_API_KEY": "fake", "DEEPSEEK_BASE_URL": "http://fake"}):
                    with redirect_stdout(stdout):
                        self.assertEqual(module.main(), 0)
        self.assertEqual(json.loads(stdout.getvalue())["output"], "model answer")
        self.assertEqual(requests[0]["temperature"], 0)
        self.assertEqual(requests[0]["messages"][0]["content"], "financial prompt")

    def test_cli_run_score_report_and_offline_rescore(self):
        with tempfile.TemporaryDirectory() as temporary:
            run_dir = Path(temporary) / "run"
            exit_code = main(
                [
                    "run",
                    "--agent",
                    "%s %s" % (sys.executable, FAKE_AGENT),
                    "--protocol",
                    "subprocess",
                    "--tasks",
                    "MB-001",
                    "--lang",
                    "zh-CN,en",
                    "--tasks-dir",
                    str(TASKS_DIR),
                    "--output",
                    str(run_dir),
                    "--retries",
                    "0",
                ]
            )
            self.assertEqual(exit_code, 0)
            for name in ("manifest.json", "scores.json", "report.json", "report.md"):
                self.assertTrue((run_dir / name).is_file())
            before = (run_dir / "scores.json").read_bytes()
            self.assertEqual(main(["score", str(run_dir), "--tasks-dir", str(TASKS_DIR)]), 0)
            self.assertEqual(before, (run_dir / "scores.json").read_bytes())
            report = json.loads((run_dir / "report.json").read_text(encoding="utf-8"))
            manifest = json.loads((run_dir / "manifest.json").read_text(encoding="utf-8"))
            self.assertIn("language_dimension_matrix", report)
            self.assertEqual(report["by_language"]["zh-CN"]["tasks"], 1)
            self.assertEqual(report["by_language"]["en"]["tasks"], 1)
            self.assertEqual({item["lang"] for item in manifest["tasks"]}, {"zh-CN", "en"})
            self.assertEqual(len({item["response_file"] for item in manifest["tasks"]}), 2)
            self.assertIn("MB-001 (en)", (run_dir / "report.md").read_text(encoding="utf-8"))

    def test_cli_diag_is_a_score_and_report_independent_sidecar(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            plain_dir = root / "plain"
            diag_dir = root / "diag"
            common = [
                "run",
                "--agent",
                "%s %s" % (sys.executable, FAKE_AGENT),
                "--protocol",
                "subprocess",
                "--tasks",
                "MB-001",
                "--lang",
                "zh-CN,en",
                "--tasks-dir",
                str(TASKS_DIR),
                "--retries",
                "0",
            ]
            self.assertEqual(main([*common, "--output", str(plain_dir)]), 0)
            self.assertEqual(main([*common, "--output", str(diag_dir), "--diag"]), 0)

            # This is the scoring invariant: diagnostics may exist on disk, but
            # score and both report formats must be byte-for-byte unchanged.
            for name in ("scores.json", "report.json", "report.md"):
                self.assertEqual((plain_dir / name).read_bytes(), (diag_dir / name).read_bytes(), name)
            self.assertFalse((plain_dir / "diag").exists())

            sidecars = sorted((diag_dir / "diag").glob("*.diag.json"))
            self.assertEqual([path.name for path in sidecars], ["MB-001.en.diag.json", "MB-001.zh-CN.diag.json"])
            for sidecar in sidecars:
                payload = json.loads(sidecar.read_text(encoding="utf-8"))
                self.assertEqual(set(payload), {"task_id", "lang", "rejected", "notes", "spans", "audit"})
                self.assertEqual(payload["task_id"], "MB-001")
                self.assertIn(payload["lang"], {"zh-CN", "en"})

    def test_cli_zh_tw_selection_runs_only_zh_tw_instance(self):
        with tempfile.TemporaryDirectory() as temporary:
            run_dir = Path(temporary) / "run"
            exit_code = main(
                [
                    "run",
                    "--agent",
                    "%s %s" % (sys.executable, FAKE_AGENT),
                    "--protocol",
                    "subprocess",
                    "--tasks",
                    "MB-001",
                    "--lang",
                    "zh-TW",
                    "--tasks-dir",
                    str(TASKS_DIR),
                    "--output",
                    str(run_dir),
                    "--retries",
                    "0",
                ]
            )
            self.assertEqual(exit_code, 0)
            manifest = json.loads((run_dir / "manifest.json").read_text(encoding="utf-8"))
            scores = json.loads((run_dir / "scores.json").read_text(encoding="utf-8"))
            self.assertEqual([item["lang"] for item in manifest["tasks"]], ["zh-TW"])
            self.assertEqual([item["lang"] for item in scores["results"]], ["zh-TW"])

    def test_all_failed_run_scores_zero_and_exits_two(self):
        with tempfile.TemporaryDirectory() as temporary:
            run_dir = Path(temporary) / "run"
            exit_code = main(
                [
                    "run",
                    "--agent",
                    "%s %s" % (sys.executable, EMPTY_AGENT),
                    "--protocol",
                    "subprocess",
                    "--tasks",
                    "all",
                    "--lang",
                    "zh-CN",
                    "--tasks-dir",
                    str(TASKS_DIR),
                    "--output",
                    str(run_dir),
                    "--retries",
                    "0",
                ]
            )
            self.assertEqual(exit_code, 2)
            manifest = json.loads((run_dir / "manifest.json").read_text(encoding="utf-8"))
            report = json.loads((run_dir / "report.json").read_text(encoding="utf-8"))
            scores = json.loads((run_dir / "scores.json").read_text(encoding="utf-8"))
            expected = sum(
                1
                for task in load_tasks(TASKS_DIR, languages=["zh-CN"])
                if not task.task.get("trap")
            )
            self.assertGreaterEqual(expected, 6)
            self.assertEqual(manifest["failed"], expected)
            self.assertEqual(len(manifest["failures"]), expected)
            self.assertEqual(report["failed"], expected)
            self.assertEqual(report["overall"], 0.0)
            self.assertTrue(all(result["status"] == "failed" for result in scores["results"]))
            self.assertTrue(all(set(result["dimensions"].values()) == {0.0} for result in scores["results"]))
            self.assertEqual(main(["score", str(run_dir), "--tasks-dir", str(TASKS_DIR)]), 2)
            self.assertEqual(main(["report", str(run_dir)]), 2)


if __name__ == "__main__":
    unittest.main()
