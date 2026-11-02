"""Keep assistant navigation honest and preserve the original task owner."""
import hashlib
import json
import subprocess
import unittest
from concurrent.futures import ThreadPoolExecutor

from tools.native_baseline import ROOT, run_command
from tools.verify_upstream import verify


class AssistantPurpose(unittest.TestCase):
    def test_h01_daily_actions_configuration_and_update_resources(self):
        self.assertTrue(verify()['verified'])
        git = r'C:\Program Files\Git\cmd\git.exe'
        files = set(subprocess.check_output([git, 'diff', 'HEAD', '--name-only', '--', 'opencode'], cwd=ROOT, text=True, encoding='utf-8').splitlines())
        files.update(subprocess.check_output([git, 'ls-files', '--others', '--exclude-standard', 'opencode'], cwd=ROOT, text=True, encoding='utf-8').splitlines())
        files.update(['tests/modules/test_assistant_purpose.py', 'tests/deployment/test_desktop_release.py', 'upstream/patches.json'])
        sources = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in sorted(files)}
        jobs = [
            ('packages/app', ['run', 'test:e2e:built', '--', 'e2e/regression/home.spec.ts', 'e2e/regression/settings.spec.ts',
                '--grep', 'assistant workspace:|module settings form:|module-owned settings', '--project', 'chromium',
                '--workers=2', '--retries=0', '--max-failures=1'], 'assistant-purpose-browser'),
            ('.', ['run', 'check'], 'assistant-purpose-check'),
            ('packages/app', ['test', '--conditions=solid', '--isolate', '--preload', '../ui/test/solid-jsx.ts',
                '--preload', './happydom.ts', './src/runtime/i18n/language.test.ts'], 'assistant-purpose-catalogs'),
        ]
        with ThreadPoolExecutor(max_workers=3) as pool:
            pending = [pool.submit(run_command, directory, args, label) for directory, args, label in jobs]
            steps = [task.result() for task in pending]
        for directory, args, label in [
            ('packages/app', ['run', 'typecheck:e2e'], 'assistant-purpose-e2e-types'),
            ('.', ['x', 'oxlint', '--deny-warnings', *[name.removeprefix('opencode/') for name in sorted(files)
                if name.endswith(('.ts', '.tsx'))]], 'assistant-purpose-lint'),
            ('packages/desktop', ['x', 'electron-vite', 'build'], 'assistant-purpose-desktop-build'),
        ]:
            steps.append(run_command(directory, args, label))
        # Exercise the real snapshot helper on temporary files, without starting any desktop or service.
        from tests.deployment.test_desktop_release import DesktopRelease
        result = unittest.TestResult()
        unittest.defaultTestLoader.loadTestsFromTestCase(DesktopRelease).run(result)
        self.assertTrue(result.wasSuccessful(), result.errors + result.failures)
        self.assertEqual(result.testsRun, 2)
        self.assertEqual(steps[0]['native_tests_passed'], 6)
        self.assertEqual(steps[2]['native_tests_passed'], 22)
        self.assertTrue(all(step['exit_code'] == 0 and step['native_tests_skipped'] == 0 for step in steps))
        self.assertIn('36 successful, 36 total', (ROOT / '.reports/native/assistant-purpose-check.log').read_text(encoding='utf-8'))
        for name, digest in sources.items():
            self.assertEqual(hashlib.sha256((ROOT / name).read_bytes()).hexdigest(), digest)
        receipt = dict(plan_id='assistant-purpose-v1', task='U3-01', status='passed', acceptance_ids=['H01'],
            sources=sources, steps=steps, browser_cases=6, catalog_cases=22, snapshot_cases=2, skipped=0,
            private_data_migrated=False, production_switch=False, new_execution_queue=False)
        (ROOT / 'tests/modules/assistant-purpose-evidence.json').write_text(
            json.dumps(receipt, ensure_ascii=False, indent=2)+'\n', encoding='utf-8', newline='\n')
