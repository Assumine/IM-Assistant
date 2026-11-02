"""Verify native-input scoped research scores/checkpoints with original Core, SQLite, MCP and real loopback I/O."""
import hashlib
import json
import subprocess

from tools.native_baseline import ROOT, run_command
from tools.research_assistance_smoke import acceptance
from tools.research_script_smoke import module_check
from tools.verify_upstream import verify


def sources():
    directory = ROOT / 'modules/research'
    files = {*directory.glob('src/**/*.ts'), *directory.glob('test/**/*.ts'), *directory.glob('*.json'),
             *directory.glob('examples/*.json'), directory / 'bun.lock'}
    files.update(ROOT / name for name in [
        'opencode/packages/server/script/research-checkpoints-smoke.ts',
        'opencode/packages/server/script/research-assistance-smoke.ts',
        'opencode/packages/server/script/research-dispatch-smoke.ts',
        'opencode/packages/server/script/research-public-branch.ts',
        'opencode/packages/schema/src/session-inbox.ts',
        'opencode/packages/core/src/session/input.ts', 'opencode/packages/core/src/session/inbox.ts',
        'opencode/packages/core/src/session/projector.ts', 'opencode/packages/core/src/session/output.ts',
        'opencode/packages/core/test/session-input.test.ts', 'opencode/packages/core/test/session-inbox-append.test.ts',
        'opencode/packages/client/src/promise/generated/types.ts', 'opencode/packages/client/src/effect/api/api.ts',
        'tools/research_checkpoints_smoke.py', 'tools/research_assistance_smoke.py', 'tools/research_script_smoke.py',
        'tools/research_public_branch.py', 'tools/native_baseline.py', 'tools/run_runtime_checks.py',
        'tests/modules/test_s1_02b.py', 'upstream/patches.json'])
    return {file.relative_to(ROOT).as_posix(): hashlib.sha256(file.read_bytes()).hexdigest() for file in sorted(files)}


def run():
    before = sources()
    if not verify()['verified']:
        raise RuntimeError('Current native provenance does not match the patch ledger')
    print('S1-02B: shared native-input scores, checkpoint validity, recovery and all prior research unit cases', flush=True)
    compiler = str(ROOT / 'opencode/node_modules/typescript/bin/tsc6')
    steps = [module_check('s2b-research-types', [compiler, '--project', 'tsconfig.json']),
             module_check('s2b-native-types', [compiler, '--project', 'tsconfig.native.json']),
             module_check('s2b-research-unit', ['test'], 65)]
    print('S1-02B: original native input/Inbox terminal projection and amendment regression, 10 repetitions', flush=True)
    native_inputs = run_command('packages/core', ['run', 'script/test.ts', 'test/session-input.test.ts',
                               'test/session-inbox-append.test.ts', '--rerun-each', '10'], 's2b-native-input-stability', timeout=120)
    if (native_inputs['native_tests_passed'], native_inputs['native_tests_failed'], native_inputs['native_tests_skipped']) != (250, 0, 0):
        raise RuntimeError('Native ownership/closure stability suite was incomplete')
    steps.append(native_inputs)
    print('S1-02B: real native model tools + official MCP share input ownership, SQLite facts and collection recovery', flush=True)
    step, native = acceptance('research-checkpoints-smoke.ts', 's2b-native-rounds', 'IM_RESEARCH_CHECKPOINT_TEST_ROOT')
    if len(native['checks']) != 8 or native['source_requests'] != 12 or native['model_requests'] != 7 or not native['native_input_owner'] or not native['official_mcp_client']:
        raise RuntimeError('Native checkpoint workflow did not execute its declared boundaries')
    steps.append(step)
    print('S1-02B: prior transferable-identity and direct-function dispatch compatibility', flush=True)
    step, role = acceptance('research-assistance-smoke.ts', 's2b-role-regression', 'IM_RESEARCH_ASSISTANCE_TEST_ROOT')
    if len(role['checks']) != 11 or role['source_requests'] != 3:
        raise RuntimeError('Existing native research identity workflow regressed')
    steps.append(step)
    step, dispatch = acceptance('research-dispatch-smoke.ts', 's2b-dispatch-regression', 'IM_RESEARCH_TEST_ROOT')
    if len(dispatch['checks']) != 11 or dispatch['source_requests'] != 5 or dispatch['model_requests']:
        raise RuntimeError('Direct trusted-function dispatcher regression failed')
    steps.append(step)
    boundaries = run_command('packages/server', ['test', 'test/application-modules.test.ts', 'test/capabilities.test.ts'], 's2b-module-boundaries')
    registry = run_command('packages/core', ['run', 'script/test.ts', 'test/tool-registry.test.ts'], 's2b-tool-registry')
    for step in [boundaries, registry]:
        if not step['native_tests_passed'] or step['native_tests_failed'] or step['native_tests_skipped']:
            raise RuntimeError('Original module/tool permission suite was incomplete')
    steps.extend([boundaries, registry])
    print('S1-02B: existing optional QQ product composition remains compatible with native terminal provenance', flush=True)
    from tools.qq_phase_smoke import acceptance as qq_acceptance
    step, qq = qq_acceptance('s2b-qq-product-regression')
    if len(qq['checks']) != 12:
        raise RuntimeError('Existing optional QQ composition regression failed')
    steps.append(step)
    plan = subprocess.run([str(ROOT / '.venv/Scripts/python.exe'), '-X', 'utf8', '-m', 'unittest',
                           'tests.test_handoff_phases', 'tests.test_plan_tools'], cwd=ROOT,
                          capture_output=True, text=True, encoding='utf-8', timeout=30,
                          creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if plan.returncode or 'Ran 17 tests' not in plan.stderr or 'OK' not in plan.stderr:
        raise RuntimeError('Active phase routing checks failed: ' + plan.stdout + plan.stderr)
    print('S1-02B: canonical 36-workspace check', flush=True)
    workspace = run_command('.', ['run', 'check'], 's2b-workspace')
    if '36 successful, 36 total' not in (ROOT / workspace['log']).read_text(encoding='utf-8'):
        raise RuntimeError('Canonical workspace checks were incomplete')
    steps.append(workspace)
    if sources() != before:
        raise RuntimeError('Checkpoint acceptance source changed during verification')
    result = {'schema_version': 1, 'plan_id': 'research-script-dispatch-v1', 'task': 'S1-02B', 'status': 'passed',
              'acceptance_ids': ['C05'], 'sources': before, 'steps': steps, 'unit_tests': 65,
              'native_input_executions': native_inputs['native_tests_passed'], 'native_input_stability_repetitions': 10,
              'boundary_tests': boundaries['native_tests_passed'], 'tool_registry_tests': registry['native_tests_passed'],
              'handoff_tests': 17, 'workspace_checks': 36, 'native_acceptance': native,
              'identity_compatibility': role, 'direct_dispatch_compatibility': dispatch, 'qq_product_compatibility': qq,
              'native_input_owner': True, 'cross_call_checkpoints_implemented': True,
              'product_entry_implemented': False, 'actual_websites': False, 'private_data_migrated': False, 'production_switch': False}
    (ROOT / 'tests/modules/research-checkpoints-evidence.json').write_bytes((json.dumps(result, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))
    return result
