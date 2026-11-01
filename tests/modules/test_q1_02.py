"""Original native module/HTTP/SQLite/persona acceptance; no live bot or private memory."""
import hashlib
import unittest

from tools.native_baseline import ROOT
from tools.qq_chatbot_smoke import run


class IndependentChatSessions(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.result = run()

    def test_b04_independent_module_failure_stop_and_forwarding(self):
        result = self.result
        self.assertEqual(result['native_chat_checks'], 17)
        self.assertEqual(result['native_acceptance']['model_requests'], 15)
        self.assertEqual(result['original_qq_tests'], 699)
        self.assertEqual(result['original_qq_chain_checks'], 147)
        self.assertEqual(result['workspace_checks'], 36)
        self.assertFalse(result['actual_qq_connection'])
        self.assertEqual(result['external_messages_sent'], 0)

    def test_b05_member_histories_use_the_original_native_database_and_private_metadata(self):
        result = self.result
        self.assertEqual(result['ownership']['history'], 'original-native-session-sqlite')
        self.assertEqual(result['ownership']['metadata'], 'module-private-plugin-kv-identities-and-fingerprints-only')
        self.assertEqual(result['native_acceptance']['shared_native_conversations'], 5)
        self.assertEqual(result['stability']['runs'], 10)
        self.assertEqual(result['stability']['chain_checks'], 170)
        for name, digest in result['sources'].items():
            with self.subTest(source=name):
                self.assertEqual(hashlib.sha256((ROOT / name).read_bytes()).hexdigest(), digest)

    def test_b06_native_personality_compaction_idempotency_and_no_task_authority(self):
        result = self.result
        self.assertEqual(result['ownership']['persona'], 'original-native-api-managed-instruction-entry')
        self.assertEqual(result['ownership']['queue'], 'original-native-inbox')
        self.assertEqual(result['ownership']['context_and_compaction'], 'original-native-runner')
        self.assertEqual(result['managed_policy']['denied_direct_apis'], 15)
        self.assertTrue(result['managed_policy']['model_tool_catalog_empty'])
        self.assertTrue(result['managed_policy']['ambient_instructions_and_file_substitution_disabled'])
        for step in [*result['steps'], *result['stability']['steps'], *result['qq_compatibility']['steps']]:
            with self.subTest(log=step.get('log')):
                self.assertEqual(step['exit_code'], 0)
                self.assertEqual(step.get('skipped', step.get('native_tests_skipped', 0)), 0)
        self.assertFalse(result['private_data_migrated'])
        self.assertFalse(result['chat_transport_configured'])
        self.assertEqual(result['publication'], 'disabled')


if __name__ == '__main__':
    unittest.main()
