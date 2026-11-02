"""Actual product entry, independent optional QQ services and native settings/UI acceptance."""
import hashlib
import unittest

from tools.native_baseline import ROOT
from tools.qq_phase_smoke import run


class QQProductComposition(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.result = run()

    def test_b10_real_configuration_runtime_state_and_independent_secret_ownership(self):
        result = self.result
        self.assertTrue(result['product_composition_implemented'])
        self.assertEqual(result['product_acceptance']['business_modules'], 2)
        self.assertEqual(result['ownership']['credentials'], 'native-provider-store-and-distinct-qq-environment-references')
        self.assertFalse(result['default_enabled'])
        self.assertFalse(result['actual_qq_connection'])
        self.assertFalse(result['production_credentials_used'])
        self.assertEqual(result['external_messages_sent'], 0)

    def test_b11_product_process_both_services_fault_stop_restart_and_context_reset(self):
        result = self.result
        self.assertEqual(result['product_checks'], 12)
        self.assertEqual(result['product_acceptance']['model_requests'], 12)
        self.assertEqual(result['product_stability']['extra_runs'], 2)
        self.assertEqual(result['product_stability']['chain_checks'], 24)
        self.assertEqual(result['ownership']['history'], 'original-native-session-sqlite')
        self.assertEqual(result['ownership']['queue'], 'original-native-inbox')
        self.assertEqual(len(result['session_compatibility']['checks']), 17)
        self.assertEqual(len(result['channel_compatibility']['checks']), 12)
        self.assertFalse(result['history_deleted'])
        self.assertFalse(result['private_data_migrated'])

    def test_b12_exact_current_source_native_ui_and_original_task_regressions(self):
        result = self.result
        self.assertEqual(result['original_qq_tests'], 699)
        self.assertEqual(result['original_qq_chain_checks'], 147)
        self.assertEqual(result['workspace_checks'], 36)
        self.assertEqual(result['browser']['executions'], 14)
        self.assertEqual(result['browser']['retries'], 0)
        self.assertGreaterEqual(result['gui_linted_files'], 5)
        self.assertEqual(result['standalone_e2e_diagnostics'], 0)
        self.assertEqual(result['managed_policy']['denied_direct_apis'], 15)
        self.assertEqual(result['publication'], 'disabled')
        for name, digest in result['sources'].items():
            with self.subTest(source=name):
                self.assertEqual(hashlib.sha256((ROOT / name).read_bytes()).hexdigest(), digest)
        for step in [*result['steps'], *result['product_stability']['steps'], *result['qq_compatibility']['steps'],
                     result['browser']['step'], result['browser']['stability']]:
            with self.subTest(log=step.get('log')):
                self.assertEqual(step['exit_code'], 0)
                self.assertEqual(step.get('skipped', step.get('native_tests_skipped', 0)), 0)


if __name__ == '__main__':
    unittest.main()
