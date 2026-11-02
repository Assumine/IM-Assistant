"""Current research product acceptance; all accounts, sources and model responses are isolated fixtures."""
import hashlib
import json
import subprocess

from tools.native_baseline import ROOT, run_command
from tools.qq_phase_smoke import acceptance as qq_acceptance
from tools.research_assistance_smoke import acceptance
from tools.research_checkpoints_smoke import sources as checkpoint_sources
from tools.research_script_smoke import module_check
from tools.verify_upstream import verify


def sources():
    files = {ROOT / name for name in checkpoint_sources()}
    files.update(ROOT / name for name in [
        'tools/research_phase_smoke.py', 'tests/modules/test_s1_03.py', 'tools/qq_phase_smoke.py',
        'opencode/packages/im-assistant/src/research.ts', 'opencode/packages/im-assistant/src/capabilities.ts',
        'opencode/packages/im-assistant/src/cli.ts', 'opencode/packages/server/script/research-phase-smoke.ts',
        'opencode/packages/server/script/qq-phase-smoke.ts', 'opencode/packages/server/src/application-modules.ts',
        'opencode/packages/server/src/middleware/runtime-policy.ts', 'opencode/packages/server/test/capabilities.test.ts',
        'opencode/packages/plugin/src/promise/application.ts', 'opencode/packages/core/src/capabilities.ts',
        'opencode/packages/codemode/src/interpreter/interpreter.ts', 'opencode/packages/codemode/src/tool-runtime.ts',
        'opencode/packages/codemode/src/tool-schema.ts',
        'opencode/packages/schema/src/capability.ts', 'opencode/packages/gui-plugins/src/capabilities/view.tsx',
        'opencode/packages/gui-plugins/src/capabilities/page.tsx', 'opencode/packages/gui-plugins/src/capabilities/i18n/en.ts',
        'opencode/packages/app/e2e/utils/capabilities.ts', 'opencode/packages/app/e2e/regression/settings.spec.ts'])
    return {p.relative_to(ROOT).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(files)}


def required(step, count=None):
    passed = step.get('passed', step.get('native_tests_passed'))
    if not passed or step.get('native_tests_failed') or step.get('skipped', step.get('native_tests_skipped', 0)) or count is not None and passed != count:
        raise RuntimeError('Required current checks did not all run: ' + step['log'])
    return step


def run():
    before = sources()
    upstream = verify()
    if not upstream['verified']:
        raise RuntimeError('Current source provenance is not verified')
    compiler = str(ROOT / 'opencode/node_modules/typescript/bin/tsc6')
    print('S1-03: strict module/harness types, all research cases and concurrent configuration stability', flush=True)
    steps = [module_check('s3-phase-types', [compiler, '--project', 'tsconfig.json']),
             module_check('s3-phase-harness-types', [compiler, '--project', 'tsconfig.native.json']),
             module_check('s3-phase-unit', ['test'], 69),
             module_check('s3-phase-settings-stability', ['test', 'test/configuration.test.ts', '--rerun-each', '10'], 40)]
    print('S1-03: actual product CLI/server, configured MCP, original AI input, fallback, help, stop and SQLite restart', flush=True)
    step, product = acceptance('research-phase-smoke.ts', 's3-phase-product', 'IM_RESEARCH_PHASE_TEST_ROOT')
    if len(product['checks']) != 12 or product['source_requests'] != 6 or product['model_requests'] != 8 or not product['official_mcp_client']:
        raise RuntimeError('Current product chain was incomplete')
    steps.append(step)
    step, repeated = acceptance('research-phase-smoke.ts', 's3-phase-product-stability', 'IM_RESEARCH_PHASE_TEST_ROOT')
    if repeated != product:
        raise RuntimeError('Product lifecycle behavior drifted between isolated runs')
    steps.append(step)
    print('S1-03: original checkpoint, identity and direct-function compatibility', flush=True)
    step, checkpoints = acceptance('research-checkpoints-smoke.ts', 's3-phase-checkpoints', 'IM_RESEARCH_CHECKPOINT_TEST_ROOT')
    steps.append(step)
    step, role = acceptance('research-assistance-smoke.ts', 's3-phase-identity', 'IM_RESEARCH_ASSISTANCE_TEST_ROOT')
    steps.append(step)
    step, dispatch = acceptance('research-dispatch-smoke.ts', 's3-phase-dispatch', 'IM_RESEARCH_TEST_ROOT')
    steps.append(step)
    if (len(checkpoints['checks']), len(role['checks']), len(dispatch['checks'])) != (8, 11, 11):
        raise RuntimeError('Existing native research contracts regressed')
    print('S1-03: both optional QQ services and original native input/Inbox and managed tool permissions', flush=True)
    step, qq = qq_acceptance('s3-phase-qq-product')
    steps.append(step)
    if len(qq['checks']) != 12 or qq['business_modules'] != 3:
        raise RuntimeError('Original QQ product composition regressed')
    steps.append(required(run_command('packages/server', ['test', 'test/application-modules.test.ts', 'test/capabilities.test.ts',
        'test/conversation-policy.test.ts'], 's3-phase-boundaries')))
    steps.append(required(run_command('packages/core', ['run', 'script/test.ts', 'test/session-input.test.ts',
        'test/session-inbox-append.test.ts', 'test/tool-registry.test.ts'], 's3-phase-input-permissions'), 67))
    steps.append(required(run_command('packages/codemode', ['test', 'test/codemode.test.ts', 'test/tool-paths.test.ts',
        'test/signature.test.ts'], 's3-phase-interpreter')))
    print('S1-03: actual built GUI, all capability keepers and event/visibility interaction repeated at CI concurrency', flush=True)
    steps.append(required(run_command('packages/app', ['run', 'test:e2e:built', '--', 'e2e/regression/settings.spec.ts',
        '--project', 'chromium', '--workers=5', '--retries=0', '-g', 'capabilities:'], 's3-phase-browser',
        timeout=600, extra_env={'PLAYWRIGHT_PORT': '4319', 'PLAYWRIGHT_FULLY_PARALLEL': '1'}), 5))
    steps.append(required(run_command('packages/app', ['run', 'test:e2e:built', '--', 'e2e/regression/settings.spec.ts',
        '--project', 'chromium', '--workers=5', '--retries=0', '-g', 'activity expands', '--repeat-each=10'],
        's3-phase-browser-stability', timeout=600, extra_env={'PLAYWRIGHT_PORT': '4319'}), 10))
    steps.append(run_command('.', ['run', 'lint:changed', 'HEAD'], 's3-phase-gui-lint'))
    # The upstream changed-file script expects a repository rooted at opencode/. This vendored layout also needs explicit paths.
    steps.append(run_command('.', ['x', 'oxlint', 'packages/gui-plugins/src/capabilities/page.tsx', 'packages/gui-plugins/src/capabilities/view.tsx',
        'packages/gui-plugins/src/capabilities/i18n/en.ts', 'packages/app/e2e/utils/capabilities.ts',
        'packages/app/e2e/regression/settings.spec.ts'], 's3-phase-gui-explicit-lint'))
    steps.append(run_command('packages/app', ['typecheck:e2e'], 's3-phase-e2e-types'))
    plan = subprocess.run([str(ROOT / '.venv/Scripts/python.exe'), '-X', 'utf8', '-m', 'unittest',
        'tests.test_handoff_phases', 'tests.test_plan_tools'], cwd=ROOT, capture_output=True, text=True, encoding='utf-8', timeout=30,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if plan.returncode or 'Ran 17 tests' not in plan.stderr or 'OK' not in plan.stderr:
        raise RuntimeError('Active plan routing checks failed: ' + plan.stdout + plan.stderr)
    print('S1-03: canonical full native lint and 36-workspace check', flush=True)
    workspace = run_command('.', ['run', 'check'], 's3-phase-workspace')
    if '36 successful, 36 total' not in (ROOT / workspace['log']).read_text(encoding='utf-8'):
        raise RuntimeError('Canonical native checks were incomplete')
    steps.append(workspace)
    if sources() != before:
        raise RuntimeError('Product acceptance source changed during verification')
    result = {'schema_version': 1, 'plan_id': 'research-script-dispatch-v1', 'task': 'S1-03', 'status': 'passed',
        'acceptance_ids': ['C07', 'C08', 'C09'], 'sources': before, 'steps': steps, 'unit_tests': 69,
        'settings_stability_executions': 40, 'browser_cases': 5, 'browser_stability_executions': 10,
        'native_test_executions': sum(step.get('passed', step.get('native_tests_passed', 0)) or 0 for step in steps),
        'product_acceptance': product, 'product_stability_runs': 2, 'checkpoint_compatibility': checkpoints,
        'identity_compatibility': role, 'direct_dispatch_compatibility': dispatch, 'qq_product_compatibility': qq,
        'handoff_tests': 17, 'workspace_checks': 36, 'provenance': upstream,
        'product_entry_implemented': True, 'native_input_owner': True, 'actual_websites': False,
        'private_data_migrated': False, 'production_switch': False}
    (ROOT / 'tests/modules/research-phase-evidence.json').write_bytes((json.dumps(result, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))
    return result
