"""R3-01 isolated feasibility acceptance, not production activation or real-account certification."""
import hashlib
import unittest

from tools.codex_native_smoke import run
from tools.native_baseline import ROOT
from tools.verify_upstream import verify


class WholeNativeBackendTests(unittest.TestCase):
    def test_01_original_source_and_declared_product_patches(self):
        self.assertTrue(verify()["verified"])

    def test_02_original_native_owners_through_real_product_and_application(self):
        # Always execute the actual pinned CLI, HTTP/SQLite, production browser and
        # module tests now. A previous checkpoint cannot make this test pass.
        result = run()
        self.assertEqual(result["status"], "partial_verified")
        self.assertEqual(result["publication"], "disabled")
        self.assertEqual(result["native_state_owner"], "codex-app-server")
        self.assertTrue(result["local_fixture_only"])
        self.assertFalse(result["production_credentials_used"])
        self.assertEqual(len(result["host_acceptance"]["checks"]), 12)
        self.assertEqual(result["host_acceptance"]["model_requests"], 4)
        self.assertEqual(result["product_acceptance"]["product_entry"], "packages/im-assistant/src/cli.ts")
        self.assertEqual(len(result["product_acceptance"]["checks"]), 7)
        self.assertEqual(result["product_acceptance"]["model_requests"], 1)
        self.assertFalse(result["product_acceptance"]["production_credentials_used"])
        for step in result["steps"]:
            with self.subTest(command=step.get("label", step.get("log"))):
                self.assertEqual(step["exit_code"], 0)
                self.assertEqual(step.get("skipped", step.get("native_tests_skipped", 0)), 0)
        for name, digest in result["sources"].items():
            with self.subTest(source=name):
                self.assertEqual(hashlib.sha256((ROOT / name).read_bytes()).hexdigest(), digest)


if __name__ == "__main__":
    unittest.main()
