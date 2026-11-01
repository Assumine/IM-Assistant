"""Presentation contracts observed at original browser, HTTP/SQLite and Windows app boundaries."""

import hashlib
import unittest

from tools.assistant_theme_smoke import run
from tools.native_baseline import ROOT


class AssistantPresentationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.result = run()

    def test_a30_fixed_navigation_sizes_and_native_windows_zoom(self):
        self.assertEqual(self.result["presentation_tests"], 15)
        desktop = self.result["desktop"]
        self.assertEqual(len(desktop["checks"]), 4)
        self.assertTrue(desktop["original_electron_app"])
        self.assertTrue(desktop["native_zoom"])
        self.assertEqual(desktop["legacy_migration_requests"], 0)
        self.assertEqual(desktop["rejected_api_requests"], 0)
        self.assertFalse(desktop["packaged_installer"])

    def test_a31_same_native_interactions_history_and_inbox_remain_ordered(self):
        self.assertEqual(self.result["interaction_before"], 57)
        self.assertEqual(self.result["interaction_after"], 57)
        self.assertEqual(self.result["native_unit_tests"], 69)
        self.assertEqual(self.result["native_conversation"]["model_requests"], 4)
        self.assertTrue(self.result["native_conversation"]["final_step_then_next_delivery_then_drain_idle"])
        self.assertTrue(self.result["native_conversation"]["restart_preserves_order_without_reexecution"])
        self.assertEqual(self.result["benchmark_runs"], 3)
        self.assertEqual(len(self.result["performance"]["after"]["samples"]), 3)

    def test_a32_current_built_sources_real_browser_and_original_desktop_are_separate_evidence(self):
        self.assertEqual(self.result["workspace_checks"], 36)
        self.assertGreater(self.result["gui_linted_files"], 0)
        self.assertEqual(self.result["browser_tests"], 72)
        for name, digest in self.result["sources"].items():
            with self.subTest(source=name):
                self.assertEqual(hashlib.sha256((ROOT / name).read_bytes()).hexdigest(), digest)
        for step in self.result["steps"]:
            with self.subTest(command=step["log"]):
                self.assertEqual(step["exit_code"], 0)
                self.assertEqual(step["native_tests_skipped"], 0)
        self.assertEqual(self.result["standalone_e2e_typecheck"]["new_diagnostics"], 0)
        self.assertEqual(self.result["publication"], "disabled")
        self.assertFalse(self.result["actual_qq_connection"])
        self.assertEqual(self.result["external_messages_sent"], 0)


if __name__ == "__main__":
    unittest.main()
