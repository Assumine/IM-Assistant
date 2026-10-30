"""R1-01: product entry/isolation uses real native application and original persistence."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import uuid

from tools.assistant_profile_smoke import profile_smoke
from tools.native_baseline import ROOT, environment, provenance, run_command
from tools.verify_upstream import verify


class AssistantProfileTests(unittest.TestCase):
    def test_01_original_source_plus_declared_product_patch(self):
        self.assertTrue(verify()["verified"])

    def test_02_profile_storage_contracts_repeated(self):
        result = run_command("packages/im-assistant", ["test", "--rerun-each", "10"], "profile-unit")
        self.assertEqual((result["native_tests_passed"], result["native_tests_failed"], result["native_tests_skipped"]), (30, 0, 0))

    def test_03_original_project_discovery_still_works(self):
        # Upstream markerless-directory tests need temp roots outside a Git checkout.
        with tempfile.TemporaryDirectory(prefix="im-assistant-native-unit-") as temporary:
            result = run_command("packages/core", ["run", "test", "test/project.test.ts"], "profile-project-regression",
                extra_env={"TMP": temporary, "TEMP": temporary, "TMPDIR": temporary})
        self.assertEqual((result["native_tests_passed"], result["native_tests_failed"], result["native_tests_skipped"]), (29, 0, 0))

    def test_04_canonical_native_lint_and_all_typechecks(self):
        self.assertEqual(run_command(".", ["run", "check"], "profile-full-check")["exit_code"], 0)

    def test_05_product_desktop_bundle(self):
        self.assertEqual(run_command("packages/desktop", ["x", "electron-vite", "build"], "profile-desktop-build")["exit_code"], 0)

    def test_06_product_cli_uses_the_same_private_native_data(self):
        root = ROOT / "runtime/baseline" / ("profile-cli-" + uuid.uuid4().hex[:12])
        env = environment("profile-test")
        env.update({"IM_ASSISTANT_DATA_ROOT": str(root), "OPENCODE_DB": str(root / "wrong-legacy.db")})
        result = subprocess.run([str(ROOT / provenance()["runtime"]["bun"]), "run", "src/cli.ts", "debug", "paths", "db"],
            cwd=ROOT / "opencode/packages/im-assistant", env=env, capture_output=True, text=True, encoding="utf-8",
            errors="replace", timeout=45, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        self.assertEqual(result.returncode, 0, result.stderr[-2000:])
        self.assertEqual(Path(result.stdout.strip()).resolve(), (root / "native/data/opencode/opencode.db").resolve())
        self.assertFalse((root / "wrong-legacy.db").exists())

    def test_07_product_window_and_native_state_survive_full_restart_in_isolation(self):
        result = profile_smoke()
        self.assertTrue(result["parent_checkout_not_discovered"])
        self.assertTrue(result["native_session_and_inbox_preserved"])
        (ROOT / ".reports/native/assistant-profile-smoke.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    unittest.main()
