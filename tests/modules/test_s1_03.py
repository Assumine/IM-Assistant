"""C07-C09 are driven through real module, native product and built-browser entry points."""
import hashlib
import unittest

from tools.native_baseline import ROOT
from tools.research_phase_smoke import run


class ResearchProduct(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.result = run()

    def test_c07_product_configuration_lifecycle_isolation_and_native_ownership(self):
        value = self.result
        self.assertEqual(value['unit_tests'], 69)
        self.assertEqual(value['settings_stability_executions'], 40)
        self.assertEqual(value['product_stability_runs'], 2)
        self.assertEqual(len(value['product_acceptance']['checks']), 12)
        self.assertTrue(value['native_input_owner'])
        self.assertTrue(value['product_entry_implemented'])

    def test_c08_actual_read_only_gui_is_visible_only_event_driven_and_technical_text_is_bounded(self):
        self.assertEqual(self.result['browser_cases'], 5)
        self.assertEqual(self.result['browser_stability_executions'], 10)
        self.assertEqual(self.result['product_acceptance']['source_requests'], 6)
        self.assertEqual(self.result['product_acceptance']['model_requests'], 8)

    def test_c09_original_regressions_and_current_verified_bytes_match_evidence(self):
        value = self.result
        self.assertEqual(len(value['checkpoint_compatibility']['checks']), 8)
        self.assertEqual(len(value['identity_compatibility']['checks']), 11)
        self.assertEqual(len(value['direct_dispatch_compatibility']['checks']), 11)
        self.assertEqual(len(value['qq_product_compatibility']['checks']), 12)
        self.assertEqual(value['handoff_tests'], 17)
        self.assertEqual(value['workspace_checks'], 36)
        self.assertFalse(value['actual_websites'])
        self.assertFalse(value['private_data_migrated'])
        self.assertFalse(value['production_switch'])
        for name, digest in value['sources'].items():
            with self.subTest(source=name):
                self.assertEqual(hashlib.sha256((ROOT / name).read_bytes()).hexdigest(), digest)
        for step in value['steps']:
            with self.subTest(command=step['args']):
                self.assertEqual(step['exit_code'], 0)
                self.assertEqual(step.get('skipped', step.get('native_tests_skipped', 0)), 0)
