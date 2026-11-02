"""Daily workspaces remain independent from configuration and native conversation ownership."""
import hashlib
import json
import unittest

from tools.workspace_smoke import ROOT, run


class AssistantWorkspaces(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.result = run()
        cls.accepted = []

    def test_f01_main_navigation_refresh_history_and_configuration(self):
        self.assertEqual(self.result['built_browser_cases'], 29)
        self.assertEqual(self.result['skipped'], 0)
        self.accepted.append('F01')

    def test_f02_assistant_landing_and_original_native_ownership(self):
        self.assertEqual(self.result['plugin_host_cases'], 31)
        self.assertTrue(self.result['cold_component_dependencies'])
        self.assertFalse(self.result['new_ai_queue'])
        self.assertEqual(self.result['model_requests'], 0)
        self.assertFalse(self.result['private_data_migrated'])
        self.accepted.append('F02')

    def test_f03_lifetimes_localization_and_final_source_bytes(self):
        self.assertEqual(self.result['catalog_cases'], 22)
        self.assertEqual(self.result['workspace_checks'], 36)
        for name, digest in self.result['sources'].items():
            with self.subTest(source=name):
                self.assertEqual(hashlib.sha256((ROOT / name).read_bytes()).hexdigest(), digest)
        self.accepted.append('F03')

    @classmethod
    def tearDownClass(cls):
        if len(set(cls.accepted)) == 3:
            (ROOT / 'tests/modules/workspace-evidence.json').write_text(
                json.dumps(cls.result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
