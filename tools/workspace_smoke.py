"""Verify assistant navigation through original built UI and real plugin hosts."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import subprocess
import shutil

from tools.native_baseline import ROOT, run_command
from tools.verify_upstream import verify


def sources():
    git = r'C:\Program Files\Git\cmd\git.exe'
    names = set(subprocess.check_output([git, 'diff', 'HEAD', '--name-only', '--', 'opencode'],
        cwd=ROOT, text=True, encoding='utf-8').splitlines())
    names.update(subprocess.check_output([git, 'ls-files', '--others', '--exclude-standard', 'opencode'],
        cwd=ROOT, text=True, encoding='utf-8').splitlines())
    names.update(['tools/workspace_smoke.py', 'tests/modules/test_workspaces.py', 'upstream/patches.json'])
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in sorted(names)}


def run():
    assert verify()['verified']
    before = sources()
    jobs = [
        ('packages/app', ['run', 'test:e2e:built', '--', 'e2e/regression/home.spec.ts',
            'e2e/regression/settings.spec.ts', '--grep',
            'assistant workspace:|whole backend Home:|Home |the session context menu|the Home shortcut|a working Home|adding a project|a server whose|the session location card|module controls:|capabilities:|Simplified Chinese|assistant appearance|usage shows honest|usage ignores',
            '--project', 'chromium', '--workers=2', '--retries=0', '--max-failures=1'], 'workspace-browser'),
        ('.', ['run', 'check'], 'workspace-canonical-check'),
        ('packages/app', ['test', '--conditions=solid', '--isolate', '--preload', '../ui/test/solid-jsx.ts',
            '--preload', './happydom.ts', './src/runtime/i18n/language.test.ts'], 'workspace-catalog-tests'),
    ]
    with ThreadPoolExecutor(max_workers=3) as pool:
        pending = [pool.submit(run_command, directory, args, label) for directory, args, label in jobs]
        steps = [job.result() for job in pending]
    cache = (ROOT / 'opencode/packages/stories/node_modules/.vite').resolve()
    assert cache.is_relative_to((ROOT / 'opencode').resolve()) and cache.name == '.vite' and cache.parent.name == 'node_modules'
    if cache.exists():
        shutil.rmtree(cache)
    steps.append(run_command('packages/app', ['x', 'playwright', 'test', '--config', 'playwright.components.config.ts',
        'plugin-', '--workers=2', '--retries=0'], 'workspace-component-hosts', timeout=420,
        extra_env={'PLAYWRIGHT_STORIES_PORT': '3294'}))
    for directory, args, label in [
        ('packages/app', ['run', 'typecheck:e2e'], 'workspace-e2e-types'),
        ('.', ['run', 'lint:changed', 'HEAD'], 'workspace-changed-lint'),
        ('.', ['x', 'oxlint', '--deny-warnings', *[name.removeprefix('opencode/') for name in before
            if name.startswith('opencode/') and name.endswith(('.ts', '.tsx'))]], 'workspace-changed-gui-lint'),
        ('packages/desktop', ['x', 'electron-vite', 'build'], 'workspace-desktop-build'),
    ]:
        steps.append(run_command(directory, args, label))
    assert steps[0]['native_tests_passed'] == 29, steps[0]
    assert steps[2]['native_tests_passed'] == 22
    assert steps[3]['native_tests_passed'] == 31, steps[3]
    assert all(step['exit_code'] == 0 and step['native_tests_skipped'] == 0 for step in steps)
    assert '36 successful, 36 total' in (ROOT / '.reports/native/workspace-canonical-check.log').read_text(encoding='utf-8')
    assert before == sources(), 'Source changed during workspace acceptance'
    return {'schema_version': 1, 'plan_id': 'assistant-workspace-v1', 'task': 'U1-01', 'status': 'passed',
        'acceptance_ids': ['F01', 'F02', 'F03'], 'built_browser_cases': 29,
        'plugin_host_cases': steps[3]['native_tests_passed'], 'cold_component_dependencies': True, 'catalog_cases': 22, 'workspace_checks': 36,
        'skipped': 0, 'steps': steps, 'sources': before, 'browser_data': 'isolated deterministic fixtures',
        'production_switch': False, 'private_data_migrated': False, 'desktop_input_automation': False,
        'new_ai_queue': False, 'model_requests': 0, 'real_qq_connections': 0}
