"""Actual native AI/MCP identity and controlled collection acceptance; never touches production profiles."""
import hashlib
import unittest

from tools.native_baseline import ROOT
from tools.research_assistance_smoke import run


class ResearchAssistanceIdentity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.result = run()

    def test_c04_any_authorized_identity_can_adopt_author_test_and_publish_shared_paths(self):
        result = self.result
        self.assertFalse(result['role_is_model_bound'])
        self.assertEqual(result['unit_tests'], 49)
        self.assertEqual(result['native_acceptance']['source_requests'], 3)
        self.assertGreater(result['native_acceptance']['model_requests'], 10)
        self.assertFalse(result['actual_websites'])

    def test_c06_official_mcp_and_native_tools_share_permissions_publication_and_native_inbox(self):
        result = self.result
        self.assertTrue(result['native_acceptance']['official_mcp_client'])
        self.assertEqual(len(result['native_acceptance']['checks']), 11)
        self.assertEqual(len(result['dispatcher_compatibility']['checks']), 11)
        self.assertEqual(result['managed_policy']['denied_direct_apis'], 15)
        self.assertEqual(result['boundary_tests'], 10)
        self.assertEqual(result['tool_registry_tests'], 42)
        self.assertEqual(len(result['qq_product_compatibility']['checks']), 12)
        self.assertFalse(result['product_entry_implemented'])
        self.assertFalse(result['cross_call_checkpoints_implemented'])

    def test_current_native_sources_and_required_checks_match_the_recorded_evidence(self):
        result = self.result
        self.assertEqual(result['handoff_tests'], 17)
        self.assertEqual(result['workspace_checks'], 36)
        self.assertFalse(result['production_switch'])
        self.assertFalse(result['private_data_migrated'])
        for source, digest in result['sources'].items():
            with self.subTest(source=source):
                self.assertEqual(hashlib.sha256((ROOT / source).read_bytes()).hexdigest(), digest)
        for step in result['steps']:
            with self.subTest(log=step['log']):
                self.assertEqual(step['exit_code'], 0)
                self.assertEqual(step.get('skipped', step.get('native_tests_skipped', 0)), 0)
