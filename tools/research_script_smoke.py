"""Run compiled research functions against isolated native Scope/SQLite and loopback I/O."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile

from tools.native_baseline import ROOT, environment, provenance, run_command
from tools.verify_upstream import verify


def sources():
    files = {p for p in (ROOT / 'modules/research').rglob('*') if p.suffix in {'.ts', '.json'} and p.is_file()}
    files.update(ROOT / name for name in [
        'opencode/packages/server/script/research-dispatch-smoke.ts',
        'opencode/packages/server/src/application-modules.ts', 'opencode/packages/core/src/capabilities.ts',
        'opencode/packages/core/src/kv.ts',
        'opencode/packages/plugin/src/promise/application.ts', 'opencode/packages/plugin/src/promise/storage.ts',
        'tools/research_script_smoke.py', 'tools/handoff_plan.py', 'tools/next_task.py',
        'tools/validate_design.py', 'tools/run_runtime_checks.py', 'tools/native_baseline.py',
        'tools/qq_protocol_smoke.py', 'tests/modules/test_s1_01.py',
        'tests/test_handoff_phases.py', 'tests/test_plan_tools.py', 'upstream/patches.json'])
    return {p.relative_to(ROOT).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(files)}


def module_check(label, args, expected=None):
    log = ROOT / '.reports/native' / (label + '.log')
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open('wb') as output:
        process = subprocess.run([str(ROOT / provenance()['runtime']['bun']), *args], cwd=ROOT / 'modules/research',
                                 env=environment('research-test'), stdout=output, stderr=subprocess.STDOUT, timeout=120,
                                 creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    content = log.read_text(encoding='utf-8', errors='replace')
    counts = re.search(r'\b(\d+) pass\s+.*?\b(\d+) fail', content, re.S)
    skipped = sum(map(int, re.findall(r'\b(\d+) (?:skip|skipped)\b', content)))
    if process.returncode or skipped or expected is not None and (not counts or (int(counts[1]), int(counts[2])) != (expected, 0)):
        raise RuntimeError('Research check failed: ' + label + '; see ' + log.relative_to(ROOT).as_posix())
    return {'cwd': 'modules/research', 'args': ['bun', *(['<pinned-typescript>', *args[1:]] if args[0].endswith('tsc6') else args)],
            'exit_code': process.returncode, 'passed': int(counts[1]) if counts else None, 'skipped': skipped,
            'log': log.relative_to(ROOT).as_posix()}


def run():
    before = sources()
    if not verify()['verified']:
        raise RuntimeError('Pinned native provenance failed')
    compiler = str(ROOT / 'opencode/node_modules/typescript/bin/tsc6')
    print('S1-01: research types, two-score selection, no attempt caps and durable round facts', flush=True)
    steps = [module_check('s1-research-types', [compiler, '--project', 'tsconfig.json']),
             module_check('s1-research-harness-types', [compiler, '--project', 'tsconfig.native.json']),
             module_check('s1-research-unit', ['test'], 25)]
    directory = tempfile.mkdtemp(prefix='research-acceptance-', dir=ROOT / 'runtime/baseline')
    print('S1-01: native Scope/SQLite restart, real loopback collectors and interruption', flush=True)
    step = run_command('packages/server', ['run', 'script/research-dispatch-smoke.ts'], 's1-research-native', timeout=120,
                       extra_env={'IM_RESEARCH_TEST_ROOT': directory})
    steps.append(step)
    result = json.loads([line for line in (ROOT / step['log']).read_text(encoding='utf-8').splitlines() if line.startswith('{')][-1])
    if (result['status'] != 'passed' or len(result['checks']) != 11 or result['source_requests'] != 5 or
            not result['native_sqlite'] or result['actual_websites'] or result['model_requests'] or
            result['actual_qq_connection'] or result['private_data_migrated'] or result['production_switch']):
        raise RuntimeError('Research native acceptance did not cover its declared boundaries')
    print('S1-01: existing native module lifecycle/capabilities and development phase selection', flush=True)
    boundary = run_command('packages/server', ['test', 'test/application-modules.test.ts', 'test/capabilities.test.ts'], 's1-native-boundaries')
    if not boundary.get('native_tests_passed') or boundary.get('native_tests_failed') or boundary.get('native_tests_skipped'):
        raise RuntimeError('Native module boundaries did not execute')
    steps.append(boundary)
    plan = subprocess.run([str(ROOT / '.venv/Scripts/python.exe'), '-X', 'utf8', '-m', 'unittest',
                           'tests.test_handoff_phases', 'tests.test_plan_tools', '-v'], cwd=ROOT,
                          capture_output=True, text=True, encoding='utf-8', timeout=30,
                          creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if plan.returncode or 'Ran 17 tests' not in plan.stderr or 'OK' not in plan.stderr:
        raise RuntimeError('Active phase routing tests failed: ' + plan.stdout + plan.stderr)
    print('S1-01: canonical native workspace check', flush=True)
    workspace = run_command('.', ['run', 'check'], 's1-research-workspace')
    if '36 successful, 36 total' not in (ROOT / workspace['log']).read_text(encoding='utf-8'):
        raise RuntimeError('The canonical workspace check was incomplete')
    steps.append(workspace)
    if sources() != before:
        raise RuntimeError('Research acceptance source changed during execution')
    record = {'schema_version': 1, 'plan_id': 'research-script-dispatch-v1', 'task': 'S1-01', 'status': 'passed',
              'acceptance_ids': ['C01', 'C02', 'C03'], 'sources': before, 'steps': steps, 'unit_tests': 25,
              'native_boundary_tests': boundary['native_tests_passed'], 'handoff_tests': 17, 'workspace_checks': 36,
              'native_acceptance': result, 'fixed_attempt_cap': False,
              'history_update': 'one-immutable-round-receipt-weighted-by-prior-rounds',
              'task_owner': 'original-native-session-and-inbox', 'product_entry_implemented': False,
              'actual_websites': False, 'private_data_migrated': False, 'production_switch': False}
    (ROOT / 'tests/modules/research-dispatch-evidence.json').write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return record


if __name__ == '__main__':
    print(json.dumps(run(), ensure_ascii=False))
