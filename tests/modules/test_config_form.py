"""Exercise configuration controls through the built native settings host."""
import hashlib
import json
import subprocess
import unittest
from tools.native_baseline import ROOT, run_command
from tools.verify_upstream import verify


class SimpleConfiguration(unittest.TestCase):
    def test_g01_typed_editing_roundtrip_and_owner_validation(self):
        self.assertTrue(verify()['verified'])
        git = r'C:\Program Files\Git\cmd\git.exe'
        files = set(subprocess.check_output([git, 'diff', 'HEAD', '--name-only', '--', 'opencode'], cwd=ROOT, text=True, encoding='utf-8').splitlines())
        files.update(subprocess.check_output([git, 'ls-files', '--others', '--exclude-standard', 'opencode'], cwd=ROOT, text=True, encoding='utf-8').splitlines())
        files.update(['tests/modules/test_config_form.py', 'upstream/patches.json'])
        sources = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in sorted(files)}
        steps = []
        steps.append(run_command('packages/app', ['run', 'test:e2e:built', '--', 'e2e/regression/settings.spec.ts',
            'e2e/regression/home.spec.ts', '--grep', 'module settings form:|module-owned settings|assistant workspace: daily',
            '--project', 'chromium', '--workers=2', '--retries=0', '--max-failures=1'], 'config-form-browser'))
        self.assertEqual(steps[0]['native_tests_passed'], 3)
        steps.append(run_command('packages/app', ['test', '--conditions=solid', '--isolate', '--preload', '../ui/test/solid-jsx.ts',
            '--preload', './happydom.ts', './src/runtime/i18n/language.test.ts'], 'config-form-catalogs'))
        self.assertEqual(steps[1]['native_tests_passed'], 22)
        for directory, args, label in [
            ('.', ['run', 'check'], 'config-form-check'),
            ('packages/app', ['run', 'typecheck:e2e'], 'config-form-e2e-types'),
            ('.', ['run', 'lint:changed', 'HEAD'], 'config-form-changed-lint'),
            ('.', ['x', 'oxlint', '--deny-warnings', *[name.removeprefix('opencode/') for name in sorted(files) if name.endswith(('.ts', '.tsx'))]], 'config-form-lint'),
            ('packages/desktop', ['x', 'electron-vite', 'build'], 'config-form-desktop-build'),
        ]:
            steps.append(run_command(directory, args, label))
        self.assertTrue(all(step['exit_code'] == 0 and step['native_tests_skipped'] == 0 for step in steps))
        for name, digest in sources.items():
            self.assertEqual(hashlib.sha256((ROOT / name).read_bytes()).hexdigest(), digest)
        receipt = dict(plan_id='simple-config-v1', task='U2-01', status='passed', acceptance_ids=['G01'],
            sources=sources, steps=steps, browser_cases=3, catalog_cases=22, skipped=0, private_data_migrated=False, production_switch=False)
        (ROOT / 'tests/modules/config-form-evidence.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
