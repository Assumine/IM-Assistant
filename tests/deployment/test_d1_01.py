"""Live entry cutover checks: real Windows entries and native HTTP, never synthetic task/history data."""
import hashlib
import json
from pathlib import Path
import subprocess
import unittest

from tools.desktop_entry import ROOT, CURRENT, LAUNCHER, PYTHONW, shell, verify, windows
from tools.verify_upstream import verify as verify_sources


class InstalledDesktopEntry(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.actual = verify()
        cls.initial_windows = windows()
        if len(cls.initial_windows) != 1:
            raise RuntimeError('The installed native desktop must have exactly one visible main window')
        cls.steps = []

    def test_d01_current_entries_and_original_backup_are_recoverable(self):
        result = self.actual
        self.assertEqual(result['shortcut_count'], 2)
        self.assertTrue(result['startup_replaced'])
        self.assertTrue(result['original_backups_verified'])
        self.assertTrue(result['legacy_fallback_verified'])
        self.assertTrue(result['unrelated_sensor_unchanged'])
        self.steps.append('live shortcuts/startup and original backup readback')

    def test_d02_desktop_shortcut_reuses_the_exact_native_window_without_models_or_qq(self):
        desktop = Path(shell().SpecialFolders('Desktop')) / '消息助手.lnk'
        import os
        os.startfile(str(desktop))
        # The shortcut's duplicate entry must exit through Electron's original application lock.
        duplicate = subprocess.Popen([str(PYTHONW), str(LAUNCHER)], cwd=ROOT,
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        self.assertEqual(duplicate.wait(timeout=45), 0)
        self.assertEqual([(x['pid'], x['handle']) for x in windows()], [(x['pid'], x['handle']) for x in self.initial_windows])
        actual = verify()
        self.assertEqual(actual['native_sessions'], 0)
        self.assertEqual(actual['modules'], {'qq-portal': 'disabled', 'qq-chatbot': 'disabled', 'research': 'disabled'})
        self.steps.append('actual desktop shortcut and repeated launcher keep the original native window and empty profile')

    def test_d03_live_profile_boundaries_current_sources_and_entry_configuration(self):
        actual = verify()
        self.assertTrue(actual['profile_is_separate'])
        self.assertFalse(actual['private_data_migrated'])
        self.assertFalse(actual['old_tasks_replayed'])
        self.assertTrue(CURRENT.is_file())
        self.assertTrue(verify_sources()['verified'])
        self.steps.append('live native API, private backup confinement and current source provenance')

    @classmethod
    def tearDownClass(cls):
        if len(cls.steps) != 3:
            return
        files = ['opencode/packages/im-assistant/script/launch.pyw', 'tools/desktop_entry.py',
                 'tests/deployment/test_d1_01.py', 'requirements-windows-entry.txt', 'tools/validate_design.py', 'upstream/patches.json']
        record = {'schema_version': 1, 'plan_id': 'desktop-entry-cutover-v1', 'task': 'D1-01',
            'status': 'passed', 'acceptance_ids': ['D01', 'D02', 'D03'], 'checks': cls.steps,
            'actual_system_entry_cutover': True, 'native_electron_window_verified': True,
            'window_reused': True, 'visual_input_and_settings_verified': False,
            'ui_validation': 'separate built renderer automation; installed window identity and native API readback', 'actual_logon_tested': False,
            'actual_qq_connection': False, 'model_requests': 0, 'private_data_migrated': False,
            'old_tasks_replayed': False, 'startup_enabled_preserved': cls.actual['original_startup_enabled'],
            'private_backups_committed': False,
            'sources': {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in files}}
        (ROOT / 'tests/deployment/desktop-entry-evidence.json').write_bytes((json.dumps(record, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))
