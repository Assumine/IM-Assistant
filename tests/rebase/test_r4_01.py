"""Current native application/RPC/GUI acceptance, not a static contract substitute."""

import hashlib
import unittest

from tools.capability_smoke import run
from tools.native_baseline import ROOT
from tools.verify_upstream import verify


class PublicApplicationCapabilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.result = run()

    def test_01_current_native_sources_and_required_harnesses(self):
        self.assertTrue(verify()["verified"])
        for name, digest in self.result["sources"].items():
            with self.subTest(source=name):
                self.assertEqual(hashlib.sha256((ROOT / name).read_bytes()).hexdigest(), digest)
        self.assertEqual(self.result["workspace_checks"], 36)
        self.assertEqual(self.result["native_unit_tests"], 704)
        self.assertEqual(self.result["browser_tests"], 34)
        for step in [*self.result["steps"], *self.result["stability"]["steps"]]:
            with self.subTest(command=step.get("log")):
                self.assertEqual(step["exit_code"], 0)
                self.assertEqual(step.get("skipped", step.get("native_tests_skipped", 0)), 0)

    def test_a27_original_application_plugin_rpc_and_gui_are_the_only_owners(self):
        self.assertEqual(self.result["ownership"]["application"], "original-native-application-scope")
        self.assertEqual(self.result["ownership"]["conversation"],
                         "original-opencode-session-inbox-or-whole-native-backend")
        self.assertEqual(self.result["qq_compatibility"]["product"]["capability_status"], "native-application-owner")

    def test_a28_optional_failure_and_stop_leave_native_running_and_queued_inputs_usable(self):
        self.assertEqual(self.result["native_chain_checks"], 152)
        self.assertEqual(len(self.result["native_acceptance"]["checks"]), 5)
        self.assertEqual(self.result["native_acceptance"]["model_requests"], 2)
        self.assertEqual(self.result["qq_compatibility"]["chain_checks"], 147)
        self.assertEqual(self.result["stability"]["native_tests"], 50)
        self.assertFalse(self.result["production_credentials_used"])
        self.assertFalse(self.result["actual_qq_connection"])
        self.assertEqual(self.result["external_messages_sent"], 0)

    def test_a29_native_unread_and_action_facts_are_separate_and_sampling_is_on_demand(self):
        self.assertEqual(self.result["ownership"]["notifications"], "original-native-kv-notice-read-resolution-facts")
        self.assertEqual(self.result["ownership"]["monitoring"], "visible-module-panel-only-no-global-hardware-poll")
        self.assertEqual(self.result["native_acceptance"]["metric_samples"], 1)
        self.assertEqual(self.result["stability"]["browser_tests"], 30)
        self.assertEqual(self.result["publication"], "disabled")


if __name__ == "__main__":
    unittest.main()
