"""Current-source localization: real catalogs, built UI, and the installed desktop."""
import hashlib
import json
from pathlib import Path
import subprocess
import unittest

from tools.desktop_entry import ROOT, verify, windows
from tools.native_baseline import run_command
from tools.verify_upstream import verify as verify_sources


class SimplifiedChineseRelease(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.catalog = run_command('packages/app', ['test', '--conditions=solid', '--isolate', '--preload',
            '../ui/test/solid-jsx.ts', '--preload', './happydom.ts', './src/runtime/i18n/language.test.ts'], 'zh-catalog-tests')
        cls.browser = run_command('packages/app', ['run', 'test:e2e:built', '--', 'e2e/regression/settings.spec.ts',
            '--grep', 'Simplified Chinese|assistant appearance|usage shows honest|usage ignores',
            '--project', 'chromium', '--workers=2', '--retries=0'], 'zh-settings-browser')
        cls.steps = []

    def test_d04_complete_catalogs_and_unchanged_interpolation(self):
        self.assertEqual(self.catalog['native_tests_passed'], 22)
        self.assertEqual(self.catalog['native_tests_skipped'], 0)
        self.assertTrue(verify_sources()['verified'])
        self.steps.append('19 real Simplified Chinese catalogs cover keys and preserve placeholders')

    def test_d05_live_language_switch_reload_and_native_usage_rendering(self):
        self.assertEqual(self.browser['native_tests_passed'], 4)
        self.assertEqual(self.browser['native_tests_skipped'], 0)
        self.steps.append('built settings host: Chinese/English, plugin lazy catalogs, reload, usage and appearance')

    def test_d06_actual_installed_window_and_current_desktop_build(self):
        self.assertEqual(len(windows()), 1)
        self.assertEqual(verify()['native_sessions'], 0)
        for name in ['zh-desktop-build', 'zh-workspace-check', 'zh-e2e-types', 'zh-changed-gui-lint']:
            check = json.loads((ROOT / '.reports/native' / (name + '.json')).read_text(encoding='utf-8'))
            self.assertEqual(check['exit_code'], 0)
        self.steps.append('installed window identity/native API readback; Chinese verified by built UI automation; build/types/lint passed')

    @classmethod
    def tearDownClass(cls):
        if len(cls.steps) != 3:
            return
        git = r'C:\Program Files\Git\cmd\git.exe'
        names = set(subprocess.check_output([git, 'diff', '--name-only', '--', 'opencode'], cwd=ROOT, text=True, encoding='utf-8').splitlines())
        names.update(subprocess.check_output([git, 'ls-files', '--others', '--exclude-standard', 'opencode'], cwd=ROOT, text=True, encoding='utf-8').splitlines())
        names.update(['tests/deployment/test_d1_02.py', 'upstream/patches.json'])
        receipt = {'schema_version': 1, 'plan_id': 'desktop-entry-cutover-v1', 'task': 'D1-02',
            'status': 'passed', 'acceptance_ids': ['D04', 'D05', 'D06'], 'checks': cls.steps,
            'catalog_tests': 22, 'catalogs': 19, 'built_browser_cases': 4,
            'skipped': 0, 'actual_desktop_observation': 'read_only_window_and_native_api; no desktop input automation',
            'browser_data': 'deterministic fixtures; actual empty installed profile checked separately',
            'model_requests': 0, 'real_qq_connection': False, 'private_data_migrated': False,
            'sources': {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in sorted(names)}}
        (ROOT / 'tests/deployment/localization-evidence.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
