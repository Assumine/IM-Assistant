"""Real dependency extraction and original product compatibility, not chatbot completion."""
import hashlib
import re
import unittest

from tools.native_baseline import ROOT
from tools.qq_protocol_smoke import run


class QQProtocolExtraction(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.result = run()

    def test_b01_shared_dependency_has_no_reverse_business_imports(self):
        for path in (ROOT / 'modules/qq-protocol/src').glob('*.ts'):
            with self.subTest(source=path.name):
                imports = re.findall(r'(?:from|import)\s*[\"\x27]([^\"\x27]+)', path.read_text(encoding='utf-8'))
                self.assertTrue(all(name.startswith('./') or name == 'node:crypto' for name in imports))
        self.assertEqual(self.result['ownership']['transport'], 'ordinary-shared-library')
        self.assertEqual(self.result['workspace_checks'], 36)
        self.assertEqual(self.result['handoff_tests'], 15)
        for name, digest in self.result['sources'].items():
            with self.subTest(source=name):
                self.assertEqual(hashlib.sha256((ROOT / name).read_bytes()).hexdigest(), digest)

    def test_b02_two_accounts_are_independent_and_one_account_has_one_owner(self):
        self.assertEqual(self.result['shared_protocol_tests'], 9)
        self.assertEqual(self.result['shared_stability_executions'], 90)
        self.assertEqual(self.result['ownership']['account_lease'], 'one-owner-per-account-per-process')
        self.assertFalse(self.result['actual_qq_connection'])
        self.assertEqual(self.result['external_messages_sent'], 0)

    def test_b03_native_task_product_entry_and_original_conversation_contracts_still_pass(self):
        self.assertEqual(self.result['native_compatibility_executions'], 699)
        self.assertEqual(self.result['native_test_executions'], 798)
        self.assertEqual(self.result['native_chain_checks'], 147)
        for step in [*self.result['steps'], *self.result['qq_compatibility']['steps']]:
            with self.subTest(log=step.get('log')):
                self.assertEqual(step['exit_code'], 0)
                self.assertEqual(step.get('skipped', step.get('native_tests_skipped', 0)), 0)
        self.assertEqual(self.result['qq_compatibility']['execution_owner']['session'], 'original-opencode-session-inbox')
        self.assertFalse(self.result['production_credentials_used'])
        self.assertFalse(self.result['private_data_migrated'])
        self.assertFalse(self.result['chatbot_implemented'])
        self.assertEqual(self.result['publication'], 'disabled')


if __name__ == '__main__':
    unittest.main()
