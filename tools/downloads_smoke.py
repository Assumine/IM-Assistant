"""Current-source download acceptance through the real engine, native host and built UI."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import re
import subprocess

from tools.native_baseline import ROOT, run_command
from tools.verify_upstream import verify


def sources():
    git = r'C:\Program Files\Git\cmd\git.exe'
    names = set(subprocess.check_output([git, 'diff', 'HEAD', '--name-only', '--', 'opencode'], cwd=ROOT,
        text=True, encoding='utf-8').splitlines())
    names.update(subprocess.check_output([git, 'ls-files', '--others', '--exclude-standard', 'opencode'], cwd=ROOT,
        text=True, encoding='utf-8').splitlines())
    names.update(str(p.relative_to(ROOT)).replace('\\', '/') for p in (ROOT / 'modules/downloads').rglob('*')
        if p.is_file() and not any(part in {'node_modules', '__pycache__'} for part in p.parts))
    names.update(['tools/downloads_smoke.py', 'tools/setup_download_dependencies.py',
        'tests/modules/test_downloads.py', 'upstream/aria2.json', 'upstream/patches.json'])
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in sorted(names)}


def run():
    assert verify()['verified'], 'Undeclared or changed upstream product patches'
    before = sources()
    commands = [
        ('.', ['test', '../modules/downloads/test/module.test.ts'], 'downloads-module-tests'),
        ('packages/server', ['test', 'test/application-modules.test.ts', 'test/capabilities.test.ts'], 'downloads-module-host-tests'),
        ('packages/server', ['test', 'test/handler-policy.test.ts', 'test/conversation-policy.test.ts',
            'test/integration-policy.test.ts'], 'downloads-host-policy-tests'),
        ('packages/server', ['run', 'script/downloads-smoke.ts'], 'downloads-product-smoke'),
        ('packages/app', ['test', '--conditions=solid', '--isolate', '--preload', '../ui/test/solid-jsx.ts',
            '--preload', './happydom.ts', './src/runtime/i18n/language.test.ts'], 'downloads-catalog-tests'),
    ]
    with ThreadPoolExecutor(max_workers=3) as workers:
        futures = [workers.submit(run_command, directory, args, label) for directory, args, label in commands]
        steps = [future.result() for future in futures]
    browser = run_command('packages/app', ['run', 'test:e2e:built', '--', 'e2e/regression/settings.spec.ts', '--grep',
        'module controls:|capabilities:|Simplified Chinese|assistant appearance|usage shows honest|usage ignores',
        '--project', 'chromium', '--workers=2', '--retries=0'], 'downloads-ui-tests')
    steps.append(browser)
    for directory, args, label in [
        ('.', ['run', 'check'], 'downloads-workspace-check'),
        ('packages/app', ['run', 'typecheck:e2e'], 'downloads-e2e-types'),
        ('.', ['check', '--no-script', '-p', '../modules/downloads/tsconfig.json'], 'downloads-module-types'),
        ('.', ['run', 'lint:changed', 'HEAD'], 'downloads-changed-lint'),
        ('.', ['x', 'oxlint', '--deny-warnings', 'packages/gui-plugins/src/capabilities/actions.tsx',
            'packages/gui-plugins/src/capabilities/view.tsx', 'packages/gui-plugins/src/capabilities/i18n/en.ts',
            'packages/gui-plugins/src/capabilities/i18n/zh.ts', 'packages/app/e2e/regression/settings.spec.ts',
            'packages/app/e2e/utils/capabilities.ts'], 'downloads-changed-gui-lint'),
        ('packages/desktop', ['x', 'electron-vite', 'build'], 'downloads-desktop-build'),
    ]:
        steps.append(run_command(directory, args, label))
    text = (ROOT / '.reports/native/downloads-product-smoke.log').read_text(encoding='utf-8')
    product = next(json.loads(line) for line in text.splitlines() if line.startswith('{"status":"passed"'))
    assert len(product['checks']) == product['count'] == 6
    for index, count in [(0, 8), (1, 12), (2, 6), (4, 22), (5, 11)]:
        assert steps[index]['native_tests_passed'] == count, steps[index]
    assert all(step['exit_code'] == 0 and step['native_tests_skipped'] == 0 for step in steps)
    check = (ROOT / '.reports/native/downloads-workspace-check.log').read_text(encoding='utf-8')
    assert re.search(r'Tasks:\s+36 successful, 36 total', check), 'Canonical workspace check did not finish'
    assert before == sources(), 'Sources changed during acceptance'
    return {'schema_version': 1, 'plan_id': 'download-module-v1', 'task': 'W1-01', 'status': 'passed',
        'acceptance_ids': ['E01', 'E02', 'E03', 'E04', 'E05'],
        'engine_tests': 8, 'host_tests': 12, 'policy_tests': 6, 'catalog_tests': 22,
        'built_browser_cases': 11, 'workspace_checks': 36, 'skipped': 0,
        'product': product, 'steps': steps, 'sources': before,
        'actual_engine': 'aria2 1.37.0', 'actual_public_bt_completed': False,
        'private_data_migrated': False, 'production_switch': False,
        'desktop_input_automation': False, 'model_requests': 0, 'real_qq_connections': 0}
