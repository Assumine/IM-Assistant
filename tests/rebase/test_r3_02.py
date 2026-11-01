"""QQ thin-forwarding acceptance on actual native chains; live account rollout stays disabled."""
import hashlib
import unittest

from tools.native_baseline import ROOT
from tools.qq_portal_smoke import run
from tools.verify_upstream import verify


class OptionalQQForwardingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Run the current implementation, never validate an old checkpoint in lieu
        # of the original CLI, SDK/HTTP/SQLite and native-backend execution.
        cls.result = run()

    def test_01_original_source_and_declared_product_patches(self):
        self.assertTrue(verify()["verified"])
        for name, digest in self.result["sources"].items():
            with self.subTest(source=name):
                self.assertEqual(hashlib.sha256((ROOT / name).read_bytes()).hexdigest(), digest)
        for step in self.result["steps"]:
            with self.subTest(command=step.get("label", step.get("log"))):
                self.assertEqual(step["exit_code"], 0)
                self.assertEqual(step.get("skipped", step.get("native_tests_skipped", 0)), 0)

    def test_a23_optional_accounts_do_not_own_application_startup(self):
        product = self.result["product_acceptance"]
        self.assertEqual(product["product_entry"], "packages/im-assistant/src/cli.ts")
        self.assertEqual(product["independent_account_checks"], 4)
        self.assertEqual(product["isolated_bot_identities"], ["10001", "10002"])
        self.assertEqual(product["loopback_connection_attempts"], 7)
        self.assertEqual(self.result["transport_acceptance"]["lifecycle"], "explicit-owner-effect-scope")
        self.assertEqual(len(self.result["notification_acceptance"]["checks"]), 6)

    def test_a24_native_inbox_and_whole_backend_keep_routing_authority(self):
        self.assertEqual(self.result["execution_owner"], {
            "session": "original-opencode-session-inbox",
            "backend": "whole-native-conversation-backend",
        })
        for name, count in [("http_acceptance", 31), ("backend_acceptance", 18),
                            ("continuation_acceptance", 7), ("guidance_acceptance", 8),
                            ("native_followup_acceptance", 8)]:
            with self.subTest(chain=name):
                self.assertEqual(len(self.result[name]["checks"]), count)
                self.assertEqual(self.result[name]["status"], "passed")

    def test_a25_history_deduplication_and_recall_use_original_admission(self):
        for name, count in [("history_acceptance", 7), ("queue_receipt_acceptance", 8),
                            ("output_acceptance", 9), ("backend_output_acceptance", 5)]:
            with self.subTest(chain=name):
                self.assertEqual(len(self.result[name]["checks"]), count)
                self.assertEqual(self.result[name]["status"], "passed")
        self.assertEqual(self.result["queue_receipt_acceptance"]["queue_notices"], 6)
        self.assertEqual(self.result["queue_receipt_acceptance"]["recall_attempts"], 6)
        self.assertEqual(self.result["source_routing"]["task_reply_targets"], ["session", "backend"])
        self.assertTrue(self.result["source_routing"]["reverse_lookup_requires_native_admission"])

    def test_a26_unknown_notifications_and_other_bots_do_not_reexecute_work(self):
        self.assertEqual(self.result["publication"], "disabled")
        self.assertFalse(self.result["production_credentials_used"])
        self.assertEqual(self.result["product_acceptance"]["second_account_task_replies"], 3)
        self.assertEqual(self.result["product_acceptance"]["isolated_quote_followups"], 2)
        self.assertEqual(self.result["product_acceptance"]["model_requests"], 7)
        for name, chain in self.result.items():
            if not name.endswith("_acceptance"):
                continue
            with self.subTest(chain=name):
                self.assertEqual(chain["status"], "passed")
                self.assertFalse(chain["actual_qq_connection"])
                self.assertEqual(chain["external_messages_sent"], 0)
                if "production_credentials_used" in chain:
                    self.assertFalse(chain["production_credentials_used"])


if __name__ == "__main__":
    unittest.main()
