"""C05: actual native input ownership, persistent branch scores/checkpoints and safe recovery."""
import hashlib
import unittest

from tools.native_baseline import ROOT
from tools.research_checkpoints_smoke import run


class ResearchInputCheckpoints(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.result = run()

    def test_c05_native_and_mcp_calls_share_native_input_scores_and_only_fold_history_at_closure(self):
        result = self.result
        self.assertTrue(result['native_input_owner'])
        self.assertTrue(result['cross_call_checkpoints_implemented'])
        self.assertEqual(result['unit_tests'], 65)
        self.assertEqual(len(result['native_acceptance']['checks']), 8)
        self.assertTrue(result['native_acceptance']['official_mcp_client'])
        self.assertEqual(result['native_acceptance']['source_requests'], 12)

    def test_c05_restart_partial_receipts_and_cancellation_use_original_native_ownership(self):
        result = self.result
        self.assertEqual(result['native_input_executions'], 250)
        self.assertEqual(result['native_input_stability_repetitions'], 10)
        self.assertEqual(len(result['identity_compatibility']['checks']), 11)
        self.assertEqual(len(result['direct_dispatch_compatibility']['checks']), 11)
        self.assertEqual(len(result['qq_product_compatibility']['checks']), 12)
        self.assertFalse(result['actual_websites'])
        self.assertFalse(result['product_entry_implemented'])
        self.assertFalse(result['private_data_migrated'])
        self.assertFalse(result['production_switch'])

    def test_current_sources_and_required_real_checks_match_the_evidence(self):
        result = self.result
        self.assertEqual(result['handoff_tests'], 17)
        self.assertEqual(result['workspace_checks'], 36)
        self.assertEqual(result['boundary_tests'], 10)
        self.assertEqual(result['tool_registry_tests'], 42)
        for source, digest in result['sources'].items():
            with self.subTest(source=source):
                self.assertEqual(hashlib.sha256((ROOT / source).read_bytes()).hexdigest(), digest)
        for step in result['steps']:
            with self.subTest(log=step['log']):
                self.assertEqual(step['exit_code'], 0)
                self.assertEqual(step.get('skipped', step.get('native_tests_skipped', 0)), 0)
