"""Real native chat policy/media/lifecycle acceptance, never a live account or old private history."""
import hashlib
import unittest

from tools.native_baseline import ROOT
from tools.qq_chatbot_channel_smoke import run


class IndependentQQChatChannel(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.result = run()

    def test_b07_independent_read_and_reply_policy_without_observation_backlog(self):
        result = self.result
        self.assertEqual(result['native_channel_checks'], 12)
        self.assertEqual(result['native_acceptance']['model_requests'], 11)
        self.assertEqual(result['ownership']['observations'], 'original-native-synthetic-history-without-inbox-or-generation')
        self.assertEqual(result['ownership']['queue'], 'original-native-inbox')
        self.assertEqual(result['native_session_checks'], 17)
        self.assertEqual(result['session_compatibility']['shared_native_conversations'], 5)
        self.assertEqual(result['stability']['runs'], 10)
        self.assertEqual(result['stability']['chain_checks'], 120)

    def test_b08_correct_member_mentions_reply_sources_and_unknown_receipt_deduplication(self):
        result = self.result
        self.assertEqual(result['native_acceptance']['loopback_send_attempts'], 7)
        self.assertEqual(result['original_qq_tests'], 699)
        self.assertEqual(result['original_qq_chain_checks'], 147)
        self.assertEqual(result['ownership']['history'], 'original-native-session-sqlite')
        self.assertEqual(result['ownership']['transport'], 'ordinary-shared-qq-protocol-dependency')
        for name, digest in result['sources'].items():
            with self.subTest(source=name):
                self.assertEqual(hashlib.sha256((ROOT / name).read_bytes()).hexdigest(), digest)

    def test_b09_controlled_media_and_stop_fences_keep_native_application_and_capability_boundary(self):
        result = self.result
        self.assertEqual(result['workspace_checks'], 36)
        self.assertEqual(result['managed_policy']['denied_direct_apis'], 15)
        self.assertTrue(result['managed_policy']['model_tool_catalog_empty'])
        self.assertTrue(result['managed_policy']['ambient_instructions_and_file_substitution_disabled'])
        for step in [*result['steps'], *result['stability']['steps'], *result['qq_compatibility']['steps']]:
            with self.subTest(log=step.get('log')):
                self.assertEqual(step['exit_code'], 0)
                self.assertEqual(step.get('skipped', step.get('native_tests_skipped', 0)), 0)
        self.assertFalse(result['actual_qq_connection'])
        self.assertFalse(result['production_credentials_used'])
        self.assertFalse(result['private_data_migrated'])
        self.assertFalse(result['default_product_composition'])
        self.assertEqual(result['external_messages_sent'], 0)
        self.assertEqual(result['publication'], 'disabled')


if __name__ == '__main__':
    unittest.main()
