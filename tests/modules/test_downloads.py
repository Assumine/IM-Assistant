"""Protect module isolation, actual transfer semantics and visible command lifetimes."""
import hashlib
import json
import unittest

from tools.downloads_smoke import ROOT, run


class DownloadsProduct(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.result = run()
        cls.accepted = []

    def test_e01_e05_native_operation_lifetime_and_product_isolation(self):
        self.assertEqual(self.result['host_tests'], 12)
        self.assertEqual(self.result['policy_tests'], 6)
        self.assertEqual(self.result['product']['count'], 6)
        self.assertEqual(self.result['product']['model_requests'], 0)
        self.assertEqual(self.result['product']['real_qq_connections'], 0)
        self.accepted.extend(['E01', 'E05'])

    def test_e02_e03_actual_engine_integrity_control_and_restart(self):
        self.assertEqual(self.result['engine_tests'], 8)
        self.assertEqual(self.result['actual_engine'], 'aria2 1.37.0')
        self.assertFalse(self.result['actual_public_bt_completed'])
        self.assertFalse(self.result['private_data_migrated'])
        self.accepted.extend(['E02', 'E03'])

    def test_e04_built_ui_and_final_source_identity(self):
        self.assertEqual(self.result['built_browser_cases'], 11)
        self.assertEqual(self.result['catalog_tests'], 22)
        self.assertEqual(self.result['workspace_checks'], 36)
        self.assertEqual(self.result['skipped'], 0)
        for name, digest in self.result['sources'].items():
            with self.subTest(source=name):
                self.assertEqual(hashlib.sha256((ROOT / name).read_bytes()).hexdigest(), digest)
        self.accepted.append('E04')

    @classmethod
    def tearDownClass(cls):
        if len(set(cls.accepted)) == 5:
            (ROOT / 'tests/modules/downloads-evidence.json').write_text(
                json.dumps(cls.result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
