"""Validate transferable research identity with actual native AI tools, HTTP/SQLite and official MCP clients."""
import hashlib
import json
import subprocess
import tempfile

from tools.assistant_policy_smoke import policy_smoke
from tools.native_baseline import ROOT, run_command
from tools.research_script_smoke import module_check
from tools.verify_upstream import verify


def sources():
    directory = ROOT / 'modules/research'
    files = {*directory.glob('src/**/*.ts'), *directory.glob('test/**/*.ts'), *directory.glob('*.json'), directory / 'bun.lock'}
    files.update(ROOT / name for name in [
        'opencode/packages/server/script/research-assistance-smoke.ts', 'opencode/packages/server/script/research-dispatch-smoke.ts',
        'opencode/packages/plugin/src/promise/application.ts', 'opencode/packages/server/src/application-modules.ts',
        'opencode/packages/core/src/capabilities.ts', 'opencode/packages/core/src/tool.ts',
        'opencode/packages/server/test/application-modules.test.ts', 'opencode/packages/server/test/capabilities.test.ts',
        'opencode/packages/core/test/tool-registry.test.ts', 'tools/research_assistance_smoke.py',
        'tools/setup_research_dependencies.py', 'tools/research_script_smoke.py', 'tests/modules/test_s1_02.py',
        'tools/qq_phase_smoke.py', 'opencode/packages/server/script/qq-phase-smoke.ts',
        'tools/handoff_plan.py', 'tools/validate_design.py', 'tests/test_handoff_phases.py', 'tests/test_plan_tools.py',
        'upstream/patches.json'])
    return {file.relative_to(ROOT).as_posix(): hashlib.sha256(file.read_bytes()).hexdigest() for file in sorted(files)}


def acceptance(script, label, variable):
    directory = tempfile.mkdtemp(prefix='research-role-acceptance-', dir=ROOT / 'runtime/baseline')
    step = run_command('packages/server', ['run', 'script/' + script], label, timeout=120, extra_env={variable: directory})
    result = json.loads([line for line in (ROOT / step['log']).read_text(encoding='utf-8').splitlines() if line.startswith('{')][-1])
    if result['status'] != 'passed' or result['actual_websites'] or result['actual_qq_connection'] or result['private_data_migrated'] or result['production_switch']:
        raise RuntimeError('Research native acceptance was incomplete or exceeded isolation')
    return step, result


def run():
    before = sources()
    if not verify()['verified']:
        raise RuntimeError('Native provenance does not match the verified code')
    print('S1-02: transferable identity, confined function authoring, source evidence, HTTP policy and original dual-score tests', flush=True)
    compiler = str(ROOT / 'opencode/node_modules/typescript/bin/tsc6')
    steps = [module_check('s2-research-types', [compiler, '--project', 'tsconfig.json']),
             module_check('s2-native-harness-types', [compiler, '--project', 'tsconfig.native.json']),
             module_check('s2-research-unit', ['test'], 49)]
    print('S1-02: actual native models adopt/build/test/publish/handoff, plus official MCP HTTP clients and native Inbox', flush=True)
    step, native = acceptance('research-assistance-smoke.ts', 's2-native-assistance', 'IM_RESEARCH_ASSISTANCE_TEST_ROOT')
    steps.append(step)
    if len(native['checks']) != 11 or native['source_requests'] != 3 or native['model_requests'] <= 10 or not native['official_mcp_client'] or native['role_is_model_bound']:
        raise RuntimeError('The native identity/MCP workflow did not fully execute')
    step, original = acceptance('research-dispatch-smoke.ts', 's2-original-dispatch', 'IM_RESEARCH_TEST_ROOT')
    steps.append(step)
    if len(original['checks']) != 11 or original['source_requests'] != 5 or original['model_requests']:
        raise RuntimeError('Original dispatcher regression failed')
    print('S1-02: trusted module lifecycle, native tool filtering/permissions and managed file capability regressions', flush=True)
    boundary = run_command('packages/server', ['test', 'test/application-modules.test.ts', 'test/capabilities.test.ts'], 's2-native-boundaries')
    registry = run_command('packages/core', ['run', 'script/test.ts', 'test/tool-registry.test.ts'], 's2-core-tools')
    for step in [boundary, registry]:
        if not step['native_tests_passed'] or step['native_tests_failed'] or step['native_tests_skipped']:
            raise RuntimeError('Required native tool/lifecycle cases did not execute')
    steps.extend([boundary, registry])
    policy = policy_smoke()
    if policy['denied_direct_apis'] != 15:
        raise RuntimeError('Managed project/file policy coverage changed')
    print('S1-02: existing optional QQ product composition regression after the shared native tool hook', flush=True)
    from tools.qq_phase_smoke import acceptance as qq_acceptance
    qq_step, qq = qq_acceptance('s2-qq-product-compat')
    steps.append(qq_step)
    if len(qq['checks']) != 12:
        raise RuntimeError('Existing QQ product composition regression was incomplete')
    plan = subprocess.run([str(ROOT / '.venv/Scripts/python.exe'), '-X', 'utf8', '-m', 'unittest',
                           'tests.test_handoff_phases', 'tests.test_plan_tools'], cwd=ROOT,
                          capture_output=True, text=True, encoding='utf-8', timeout=30,
                          creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if plan.returncode or 'Ran 17 tests' not in plan.stderr or 'OK' not in plan.stderr:
        raise RuntimeError('Plan routing tests failed: ' + plan.stdout + plan.stderr)
    print('S1-02: canonical native workspace check', flush=True)
    workspace = run_command('.', ['run', 'check'], 's2-research-workspace')
    if '36 successful, 36 total' not in (ROOT / workspace['log']).read_text(encoding='utf-8'):
        raise RuntimeError('Canonical workspace coverage was incomplete')
    steps.append(workspace)
    if sources() != before:
        raise RuntimeError('Research identity acceptance sources changed during execution')
    result = {'schema_version': 1, 'plan_id': 'research-script-dispatch-v1', 'task': 'S1-02', 'status': 'passed',
              'acceptance_ids': ['C04', 'C06'], 'sources': before, 'steps': steps, 'unit_tests': 49,
              'boundary_tests': boundary['native_tests_passed'], 'tool_registry_tests': registry['native_tests_passed'],
              'handoff_tests': 17, 'workspace_checks': 36, 'managed_policy': policy, 'native_acceptance': native,
              'dispatcher_compatibility': original, 'qq_product_compatibility': qq, 'role_is_model_bound': False, 'mcp_sdk': '2.3.1',
              'cross_call_checkpoints_implemented': False, 'product_entry_implemented': False,
              'actual_websites': False, 'private_data_migrated': False, 'production_switch': False}
    (ROOT / 'tests/modules/research-assistance-evidence.json').write_bytes((json.dumps(result, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))
    return result
