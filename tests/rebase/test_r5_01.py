"""Release gates observe the original application, not Python emulations of its state machines."""

import hashlib
import unittest

from tools.native_baseline import ROOT
from tools.release_smoke import run


class ReleaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.result = run()

    def test_a33_current_native_and_browser_regressions_are_reproducible(self):
        result = self.result
        self.assertEqual(result["status"], "verified")
        self.assertEqual(result["workspace_checks"], 36)
        self.assertEqual(result["standalone_e2e_diagnostics"], 0)
        self.assertGreaterEqual(result["gui_linted_files"], 8)
        self.assertEqual(result["policy"]["denied_direct_apis"], 15)
        self.assertTrue(result["conversation"]["final_step_then_next_delivery_then_drain_idle"])
        for name, digest in result["sources"].items():
            with self.subTest(source=name):
                self.assertEqual(hashlib.sha256((ROOT / name).read_bytes()).hexdigest(), digest)

    def test_a34_faults_and_notifications_do_not_create_another_execution_owner(self):
        self.assertTrue(self.result["crash"]["completed_input_not_replayed"])
        self.assertTrue(self.result["crash"]["parked_input_identity_and_order_restored"])
        self.assertEqual(self.result["codex"]["native_tests"], 30)
        self.assertEqual(self.result["codex"]["race_stability_tests"], 6)
        self.assertEqual(self.result["codex"]["http_checks"], 19)
        qq = self.result["qq"]
        self.assertEqual(len(qq["notification_acceptance"]["checks"]), 6)
        self.assertEqual(qq["notification_acceptance"]["native_task_inputs"], 0)
        self.assertFalse(self.result["production_credentials_used"])
        self.assertEqual(self.result["external_messages_sent"], 0)

    def test_a35_performance_has_comparable_sources_and_raw_samples(self):
        native = self.result["native_performance"]
        self.assertTrue(native["identity"]["production_sources_identical"])
        self.assertEqual(len(native["samples"]), 6)
        self.assertEqual(len(self.result["rendering"]["current"]["samples"]), 3)
        self.assertTrue(self.result["rendering"]["same_fixture"])

    def test_a36_handover_and_rollback_preserve_the_accepting_owner(self):
        migration = self.result["migration"]
        self.assertEqual(migration["accepting_owners"], ["source", "source", "destination", "source"])
        self.assertEqual(migration["model_requests"], 4)
        self.assertTrue(migration["duplicate_import_conflicts_without_overwrite"])
        self.assertTrue(migration["both_histories_survive_restart"])
        self.assertEqual(migration["production_databases_touched"], 0)
        self.assertEqual(self.result["publication"], "disabled")
        self.assertFalse(self.result["production_switched"])


if __name__ == "__main__":
    unittest.main()
