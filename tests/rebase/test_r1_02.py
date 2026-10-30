"""R1-02 drives the native capability boundary, application UI and persistence."""
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from tools.assistant_policy_smoke import policy_smoke
from tools.assistant_profile_smoke import profile_smoke
from tools.native_baseline import ROOT, environment, provenance, run_command
from tools.verify_upstream import verify


class ConversationRuntimeTests(unittest.TestCase):
    def test_01_original_source_and_product_patch_ledger(self):
        self.assertTrue(verify()["verified"])

    def test_02_native_policy_and_original_registry_contracts(self):
        with tempfile.TemporaryDirectory(prefix="im-assistant-policy-unit-") as temporary:
            result = run_command("packages/core", ["run", "test", "test/runtime-policy.test.ts",
                "test/session-owned.test.ts", "test/plugin/provider-dynamic.test.ts", "test/tool-registry.test.ts"],
                "policy-native-core", extra_env={"TMP": temporary, "TEMP": temporary, "TMPDIR": temporary})
        self.assertGreaterEqual(result["native_tests_passed"], 30)
        self.assertEqual((result["native_tests_failed"], result["native_tests_skipped"]), (0, 0))
        bootstrap = run_command("packages/cli", ["test", "--timeout", "30000", "test/web-ui.test.ts"], "policy-native-web-bootstrap")
        self.assertEqual((bootstrap["native_tests_passed"], bootstrap["native_tests_failed"], bootstrap["native_tests_skipped"]), (4, 0, 0))

    def test_03_actual_http_policy_keeps_native_history_attachments_and_inbox(self):
        result = policy_smoke()
        self.assertEqual(result["denied_direct_apis"], 15)
        self.assertTrue(result["native_import_export_and_restart"])
        self.assertTrue(result["configured_plugin_and_mcp_blocked"])
        (ROOT / ".reports/native/assistant-policy-smoke.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")

    def test_04_managed_cli_rejects_generic_execution(self):
        with tempfile.TemporaryDirectory(prefix="policy-cli-", dir=ROOT / "runtime/baseline") as temporary:
            env = environment("policy-cli")
            env.update({"IM_ASSISTANT_DATA_ROOT": temporary})
            result = subprocess.run([str(ROOT / provenance()["runtime"]["bun"]), "run", "src/cli.ts", "run", "echo forbidden"],
                cwd=ROOT / "opencode/packages/im-assistant", env=env, capture_output=True, text=True, encoding="utf-8",
                errors="replace", timeout=45, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("managed conversation service only", result.stderr)
            self.assertFalse((Path(temporary) / "native/data/opencode/opencode.db").exists())

    def test_05_canonical_native_checks(self):
        self.assertEqual(run_command(".", ["run", "check"], "policy-full-check")["exit_code"], 0)

    def test_06_production_browser_keeps_byte_attachments_and_removes_coding_controls(self):
        result = run_command("packages/app", ["run", "test:e2e:built", "--", "e2e/regression/composer.spec.ts",
            "--grep", "conversation host", "--project", "chromium", "--workers=1", "--retries=0"], "policy-web-ui",
            extra_env={"PLAYWRIGHT_PORT": "4381"})
        self.assertEqual((result["native_tests_passed"], result["native_tests_failed"], result["native_tests_skipped"]), (2, 0, 0))

    def test_07_native_desktop_build_and_private_profile_restart(self):
        self.assertEqual(run_command("packages/desktop", ["x", "electron-vite", "build"], "policy-desktop-build")["exit_code"], 0)
        result = profile_smoke()
        self.assertTrue(result["managed_location_composer_ready"])
        self.assertTrue(result["native_session_and_inbox_preserved"])
        (ROOT / ".reports/native/assistant-profile-smoke.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    unittest.main()
