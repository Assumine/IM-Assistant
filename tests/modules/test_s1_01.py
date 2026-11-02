"""Actual Bun research implementation and native HTTP/SQLite acceptance, no real accounts."""
import hashlib
import unittest

from tools.native_baseline import ROOT
from tools.research_script_smoke import run


class ResearchScriptDispatch(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.result = run()

    def test_c01_compiled_functions_parameter_selection_and_score_only_termination(self):
        result = self.result
        self.assertEqual(result['unit_tests'], 25)
        self.assertFalse(result['fixed_attempt_cap'])
        self.assertEqual(result['native_acceptance']['source_requests'], 5)
        self.assertFalse(result['actual_websites'])

    def test_c02_round_summary_is_the_only_weighted_historical_fact(self):
        result = self.result
        self.assertEqual(result['history_update'], 'one-immutable-round-receipt-weighted-by-prior-rounds')
        self.assertTrue(result['native_acceptance']['native_sqlite'])
        self.assertEqual(len(result['native_acceptance']['checks']), 11)
        for source, digest in result['sources'].items():
            with self.subTest(source=source):
                self.assertEqual(hashlib.sha256((ROOT / source).read_bytes()).hexdigest(), digest)

    def test_c03_native_lifecycle_queue_isolation_restart_and_no_production_claim(self):
        result = self.result
        self.assertEqual(result['task_owner'], 'original-native-session-and-inbox')
        self.assertGreater(result['native_boundary_tests'], 0)
        self.assertEqual(result['handoff_tests'], 17)
        self.assertEqual(result['workspace_checks'], 36)
        self.assertFalse(result['product_entry_implemented'])
        self.assertFalse(result['production_switch'])
        self.assertFalse(result['private_data_migrated'])
        self.assertEqual(result['native_acceptance']['model_requests'], 0)
        for step in result['steps']:
            with self.subTest(log=step['log']):
                self.assertEqual(step['exit_code'], 0)
                self.assertEqual(step.get('skipped', step.get('native_tests_skipped', 0)), 0)


if __name__ == '__main__':
    unittest.main()
