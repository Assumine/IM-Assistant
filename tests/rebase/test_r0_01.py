"""R0 acceptance drives original source builds/tests and real isolated processes."""
import json
import subprocess
import unittest

from tools.native_baseline import ROOT, environment, provenance, run_command
from tools.native_api_smoke import inbox_restart_smoke, history_restart_smoke
from tools.native_desktop_smoke import desktop_smoke
from tools.verify_upstream import verify


class NativeBaselineTests(unittest.TestCase):
    def assert_native_suite(self, receipt, expected):
        self.assertEqual(receipt["exit_code"], 0)
        self.assertEqual(receipt["native_tests_passed"], expected)
        self.assertEqual(receipt["native_tests_failed"], 0)
        self.assertEqual(receipt["native_tests_skipped"], 0)

    def test_01_locked_source_and_toolchain(self):
        checked = verify()
        self.assertGreater(checked["source_files"], 9000)
        self.assertTrue(checked["verified"])
        record = provenance()
        for runtime, version in (("bun", record["package_manager"].split("@", 1)[1]), ("node", record["runtime"]["node_version"])):
            result = subprocess.run([str(ROOT / record["runtime"][runtime]), "--version"],
                env=environment(), capture_output=True, text=True, check=True)
            self.assertEqual(result.stdout.strip(), version)
        patches = json.loads((ROOT / "upstream/patches.json").read_text(encoding="utf-8"))["patches"]
        self.assertEqual(bool(patches), record["source_modified"])

    def test_02_native_session_core(self):
        files = ["session-prompt", "session-store", "session-run-coordinator", "session-compact", "session-native-compaction", "session-view"]
        self.assert_native_suite(run_command("packages/core", ["run", "test", *[f"test/{name}.test.ts" for name in files]], "core-session"), 92)

    def test_03_native_desktop_storage(self):
        self.assert_native_suite(run_command("packages/desktop", ["test", "--timeout", "30000", "src/main/storage"], "desktop-storage"), 30)

    def test_04_native_frontend_queue_and_list(self):
        self.assert_native_suite(run_command("packages/app", ["test", "--conditions=solid", "--preload", "../ui/test/solid-jsx.ts",
            "--preload", "./happydom.ts", "src/session/composer/queue.test.ts", "src/session/list.test.ts"], "app-queue-unit"), 19)

    def test_05_original_web_build_and_browser_regressions(self):
        # Upstream browser fixtures mock HTTP; real HTTP/SQLite is covered separately below.
        # The keeper files now include the 45 original cases plus 2 R2-01 conversation-host regressions.
        self.assert_native_suite(run_command("packages/app", ["run", "test:e2e:built", "--",
            "e2e/regression/session-queue.spec.ts", "e2e/regression/timeline-history.spec.ts", "--workers=2", "--retries=0"],
            "native-web-e2e", extra_env={"PLAYWRIGHT_PORT": "4380"}), 47)

    def test_06_original_desktop_bundle_build(self):
        self.assertEqual(run_command("packages/desktop", ["x", "electron-vite", "build"], "desktop-build")["exit_code"], 0)

    def test_07_real_http_inbox_restart(self):
        self.assertTrue(inbox_restart_smoke()["restart_preserves_inbox"])

    def test_08_real_http_history_restart_with_synthetic_model(self):
        result = history_restart_smoke()
        self.assertTrue(result["restart_preserves_history"])
        self.assertEqual(result["external_model_requests"], 0)

    def test_09_original_windows_desktop_launch_and_reopen(self):
        receipt = desktop_smoke()
        self.assertEqual(len(receipt["boots"]), 2)
        self.assertTrue(all(boot["ready"] for boot in receipt["boots"]))


if __name__ == "__main__":
    unittest.main()
