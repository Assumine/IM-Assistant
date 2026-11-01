"""QQ dependency extraction acceptance using native code and authenticated loopback only."""
import hashlib
import json
from pathlib import Path
import re
import subprocess

from tools.native_baseline import ROOT, environment, provenance, run_command
from tools.qq_portal_smoke import _run


def sources():
    previous = json.loads((ROOT / 'upstream/qq-checkpoint.json').read_text(encoding='utf-8'))
    files = {ROOT / name for name in previous['sources']}
    for module in ['qq-protocol', 'qq-portal']:
        directory = ROOT / 'modules' / module
        files.update(directory.glob('src/*.ts'))
        files.update(directory.rglob('test/**/*.ts'))
        files.update(directory / name for name in ['package.json', 'tsconfig.json'])
    files.update(ROOT / name for name in ['tools/qq_protocol_smoke.py', 'tools/handoff_plan.py',
                 'tools/next_task.py', 'tools/run_runtime_checks.py', 'tools/validate_design.py',
                 'tests/test_handoff_phases.py', 'tests/test_plan_tools.py', 'tests/modules/test_q1_01.py'])
    return {p.relative_to(ROOT).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(files)}


def module_check(module, label, args, expected=None):
    log = ROOT / '.reports/native' / f'{label}.log'
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open('wb') as output:
        process = subprocess.run([str(ROOT / provenance()['runtime']['bun']), *args],
                                 cwd=ROOT / 'modules' / module, env=environment('qq-protocol'),
                                 stdout=output, stderr=subprocess.STDOUT, timeout=120,
                                 creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    content = log.read_text(encoding='utf-8', errors='replace')
    counts = re.search(r'\b(\d+) pass\s+.*?\b(\d+) fail', content, re.S)
    skipped = sum(map(int, re.findall(r'\b(\d+) (?:skip|skipped)\b', content)))
    if process.returncode or skipped or expected is not None and (not counts or (int(counts[1]), int(counts[2])) != (expected, 0)):
        raise RuntimeError(f'QQ protocol check failed: {label}; see {log.relative_to(ROOT)}')
    return {'cwd': f'modules/{module}', 'args': ['bun', *args], 'exit_code': process.returncode,
            'passed': int(counts[1]) if counts else None, 'skipped': skipped, 'log': log.relative_to(ROOT).as_posix()}


def run():
    before = sources()
    print('Q1-01: shared dependency types, public API and two-consumer isolation', flush=True)
    steps = [module_check('qq-protocol', 'q1-protocol-types',
                         [str(ROOT / 'opencode/node_modules/typescript/bin/tsc6'), '--project', 'tsconfig.json']),
             module_check('qq-protocol', 'q1-protocol-tests', ['test'], 9),
             module_check('qq-protocol', 'q1-protocol-stability', ['test', 'test/isolation.test.ts', '--rerun-each', '10'], 90)]
    python = subprocess.run([str(ROOT / '.venv/Scripts/python.exe'), '-X', 'utf8', '-m', 'unittest',
                             'tests.test_handoff_phases', 'tests.test_plan_tools', '-v'], cwd=ROOT,
                            capture_output=True, text=True, encoding='utf-8', timeout=30,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if python.returncode or 'Ran 15 tests' not in python.stderr or 'OK' not in python.stderr:
        raise RuntimeError('Handoff phase selection checks failed: ' + python.stdout + python.stderr)
    print('Q1-01: original QQ native Session, Inbox, backend, image, reply and product regressions', flush=True)
    compatibility = _run()
    native_count = sum(step.get('passed', step.get('native_tests_passed', 0)) or 0 for step in compatibility['steps'])
    chain = sum(len(value['checks']) for key, value in compatibility.items() if key.endswith('_acceptance'))
    if native_count != 699 or chain != 147:
        raise RuntimeError('The original QQ regression coverage changed; review actual results')
    print('Q1-01: canonical native workspace check', flush=True)
    steps.append(run_command('.', ['run', 'check'], 'q1-protocol-workspace'))
    if '36 successful, 36 total' not in (ROOT / steps[-1]['log']).read_text(encoding='utf-8'):
        raise RuntimeError('The canonical check did not cover every native workspace')
    if sources() != before:
        raise RuntimeError('Acceptance source changed during verification')
    result = {'schema_version': 1, 'plan_id': 'qq-plugin-migration-v1', 'task': 'Q1-01',
              'status': 'passed', 'publication': 'disabled', 'scope': 'isolated-protocol-extraction-not-chatbot-rollout',
              'sources': before, 'steps': steps, 'handoff_tests': 15, 'shared_protocol_tests': 9,
              'shared_stability_executions': 90, 'native_compatibility_executions': native_count,
              'native_test_executions': native_count + 99, 'native_chain_checks': chain, 'workspace_checks': 36,
              'qq_compatibility': compatibility, 'actual_qq_connection': False, 'production_credentials_used': False,
              'external_messages_sent': 0, 'private_data_migrated': False, 'chatbot_implemented': False,
              'ownership': {'transport': 'ordinary-shared-library', 'account_lease': 'one-owner-per-account-per-process',
                            'session': 'original-native-session-inbox-or-whole-backend',
                            'business_policies': 'independent-consumer-plugins'},
              'remaining': ['qq-chatbot native sessions/personality/remembered-member policy and actual configuration are subsequent tasks',
                            'cross-process account leases, automatic reconnect and unknown remote-send reconciliation are not implemented',
                            'live QQ, user model accounts, private data migration and production switching remain unverified']}
    output = ROOT / 'tests/modules/qq-protocol-evidence.json'
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
    return result
