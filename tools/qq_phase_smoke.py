"""QQ product composition acceptance; all credentials, accounts, traffic and histories are synthetic/local."""
import hashlib
import json
import re
import tempfile

from tools.assistant_policy_smoke import policy_smoke
from tools.native_baseline import ROOT, run_command
from tools.qq_chatbot_smoke import acceptance as session_acceptance
from tools.qq_chatbot_channel_smoke import acceptance as channel_acceptance
from tools.qq_portal_smoke import _run
from tools.qq_protocol_smoke import module_check
from tools.verify_upstream import verify


def sources():
    prior = json.loads((ROOT / 'tests/modules/qq-chatbot-channel-evidence.json').read_text(encoding='utf-8'))
    files = {ROOT / name for name in prior['sources']}
    for name in ['qq-chatbot', 'qq-protocol']:
        directory = ROOT / 'modules' / name
        files.update(directory.glob('src/*.ts'))
        files.update(directory.rglob('test/**/*.ts'))
        files.update(directory.glob('*.json'))
    files.update(ROOT / name for name in [
        'tools/qq_phase_smoke.py', 'tests/modules/test_q1_04.py',
        'opencode/packages/im-assistant/src/chatbots.ts', 'opencode/packages/im-assistant/src/capabilities.ts',
        'opencode/packages/im-assistant/src/portals.ts', 'opencode/packages/im-assistant/src/cli.ts',
        'opencode/packages/plugin/src/promise/application.ts', 'opencode/packages/plugin/src/promise/index.ts',
        'opencode/packages/core/src/capabilities.ts', 'opencode/packages/schema/src/capability.ts',
        'opencode/packages/server/src/application-modules.ts', 'opencode/packages/server/script/qq-phase-smoke.ts',
        'opencode/packages/server/test/capabilities.test.ts',
        'opencode/packages/gui-plugins/src/capabilities/page.tsx', 'opencode/packages/gui-plugins/src/capabilities/settings.tsx',
        'opencode/packages/gui-plugins/src/capabilities/i18n/en.ts',
        'opencode/packages/app/e2e/utils/capabilities.ts', 'opencode/packages/app/e2e/regression/settings.spec.ts'])
    return {p.relative_to(ROOT).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(files)}


def acceptance(label):
    directory = tempfile.mkdtemp(prefix='qq-phase-', dir=ROOT / 'runtime/baseline')
    step = run_command('packages/server', ['run', 'script/qq-phase-smoke.ts'], label, timeout=240,
                       extra_env={'IM_QQ_PHASE_TEST_ROOT': directory})
    lines = (ROOT / step['log']).read_text(encoding='utf-8').splitlines()
    result = json.loads([line for line in lines if line.startswith('{')][-1])
    if (result['status'] != 'passed' or len(result['checks']) != 12 or result['model_requests'] != 12 or
            result['business_modules'] != 2 or result['history_deleted'] or result['actual_qq_connection'] or
            result['production_credentials_used'] or result['external_messages_sent'] or result['private_data_migrated'] or
            result['product_entry'] != 'packages/im-assistant/src/cli.ts'):
        raise RuntimeError('QQ real-product composition acceptance was incomplete')
    return step, result


def required_tests(step):
    if not step['native_tests_passed'] or step['native_tests_failed'] or step['native_tests_skipped']:
        raise RuntimeError('Required native tests did not all run: ' + step['log'])
    return step


def run():
    before = sources()
    provenance = verify()
    if not provenance['verified']:
        raise RuntimeError('Upstream patch provenance is invalid')
    print('Q1-04: module configuration/types and actual revision-based persistence', flush=True)
    compiler = str(ROOT / 'opencode/node_modules/typescript/bin/tsc6')
    steps = [module_check('qq-chatbot', 'q4-phase-module-types', [compiler, '--project', 'tsconfig.json']),
             module_check('qq-chatbot', 'q4-phase-harness-types', [compiler, '--project', 'tsconfig.native.json']),
             module_check('qq-chatbot', 'q4-phase-unit', ['test'], 23),
             module_check('qq-chatbot', 'q4-phase-settings-stability', ['test', 'test/settings.test.ts', '--rerun-each', '10'], 60),
             module_check('qq-protocol', 'q4-phase-protocol-unit', ['test'], 13)]
    print('Q1-04: actual product CLI/server, native settings RPC, both QQ plugins and explicit context reset', flush=True)
    step, product = acceptance('q4-phase-product')
    steps.append(step)
    stability = []
    for number in range(2):
        step, result = acceptance(f'q4-phase-product-stability-{number + 1}')
        if result != product:
            raise RuntimeError('Product stability coverage drifted')
        stability.append(step)
    print('Q1-04: original native chat context/persona and raw QQ/media channel compatibility', flush=True)
    step, sessions = session_acceptance('q4-phase-prior-sessions')
    steps.append(step)
    step, channel = channel_acceptance('q4-phase-prior-channel')
    steps.append(step)
    for package, args, label in [
        ('packages/server', ['test', '--timeout', '30000', 'test/capabilities.test.ts', 'test/conversation-policy.test.ts'], 'q4-phase-capability-policy'),
        ('packages/core', ['run', 'script/test.ts', 'test/session-instructions.test.ts', 'test/instruction-state.test.ts',
                          'test/session-native-compaction.test.ts'], 'q4-phase-native-instructions'),
    ]:
        steps.append(required_tests(run_command(package, args, label)))
    managed = policy_smoke()
    if managed['denied_direct_apis'] != 15 or not managed['model_tool_catalog_empty'] or not managed['ambient_instructions_and_file_substitution_disabled']:
        raise RuntimeError('Managed file/tool capability boundary regressed')
    print('Q1-04: original QQ/Codex/native Inbox/task forwarding regressions', flush=True)
    qq = _run()
    original_tests = sum(step.get('passed', step.get('native_tests_passed', 0)) or 0 for step in qq['steps'])
    original_checks = sum(len(value['checks']) for key, value in qq.items() if key.endswith('_acceptance'))
    if original_tests != 699 or original_checks != 147:
        raise RuntimeError('Original QQ task forwarding coverage drifted')
    print('Q1-04: real browser module settings/notifications/monitor and new settings interaction stability', flush=True)
    browser = required_tests(run_command('packages/app', ['run', 'test:e2e:built', '--', 'e2e/regression/settings.spec.ts',
        '--project', 'chromium', '--workers=2', '--retries=0', '-g', 'capabilities:'], 'q4-phase-browser', timeout=600,
        extra_env={'PLAYWRIGHT_PORT': '4317'}))
    if browser['native_tests_passed'] != 4:
        raise RuntimeError('Required module browser cases are missing')
    browser_stability = required_tests(run_command('packages/app', ['run', 'test:e2e:built', '--', 'e2e/regression/settings.spec.ts',
        '--project', 'chromium', '--workers=5', '--retries=0', '-g', 'module-owned settings', '--repeat-each=10'],
        'q4-phase-browser-stability', timeout=600, extra_env={'PLAYWRIGHT_PORT': '4317'}))
    if browser_stability['native_tests_passed'] != 10:
        raise RuntimeError('Required browser stability cases did not all execute')
    print('Q1-04: canonical workspace, strict GUI lint and standalone E2E typing', flush=True)
    steps.append(run_command('.', ['run', 'check'], 'q4-phase-workspace', timeout=600))
    if '36 successful, 36 total' not in (ROOT / steps[-1]['log']).read_text(encoding='utf-8'):
        raise RuntimeError('Canonical workspace coverage incomplete')
    steps.append(run_command('.', ['run', 'lint:changed', '0580910bdbfdf8ecea4d5c5a2fd1f4ae08d7049f'], 'q4-phase-gui-lint', timeout=180,
        extra_env={'GIT_CONFIG_COUNT': '1', 'GIT_CONFIG_KEY_0': 'diff.relative', 'GIT_CONFIG_VALUE_0': 'true'}))
    lint = re.search(r'0 problem\(s\) in 0 of (\d+) changed files', (ROOT / steps[-1]['log']).read_text(encoding='utf-8'))
    if not lint or int(lint[1]) < 5:
        raise RuntimeError('The GUI lint must actually inspect the changed UI and keeper files')
    steps.append(run_command('packages/app', ['run', 'typecheck:e2e'], 'q4-phase-e2e-types', timeout=180))
    if sources() != before:
        raise RuntimeError('Acceptance source changed during verification')
    unit = original_tests + sum(step.get('passed', step.get('native_tests_passed', 0)) or 0 for step in steps)
    result = {'schema_version': 1, 'plan_id': 'qq-plugin-migration-v1', 'task': 'Q1-04', 'status': 'passed',
              'publication': 'disabled', 'scope': 'real-product-composition-with-isolated-accounts-not-live-rollout',
              'sources': before, 'steps': steps, 'product_acceptance': product, 'session_compatibility': sessions,
              'channel_compatibility': channel, 'product_stability': {'steps': stability, 'extra_runs': 2, 'chain_checks': 24},
              'browser': {'step': browser, 'stability': browser_stability, 'executions': 14, 'retries': 0},
              'native_test_executions': unit, 'product_checks': 12, 'original_qq_tests': original_tests,
              'original_qq_chain_checks': original_checks, 'workspace_checks': 36, 'gui_linted_files': int(lint[1]),
              'standalone_e2e_diagnostics': 0, 'qq_compatibility': qq, 'managed_policy': managed,
              'actual_qq_connection': False, 'production_credentials_used': False, 'external_messages_sent': 0,
              'private_data_migrated': False, 'history_deleted': False, 'default_enabled': False,
              'product_composition_implemented': True, 'provenance': provenance,
              'ownership': {'host': 'original-native-application-scope', 'history': 'original-native-session-sqlite',
                            'queue': 'original-native-inbox', 'settings': 'module-owned-declarative-json-with-native-capability-rpc-and-gui',
                            'credentials': 'native-provider-store-and-distinct-qq-environment-references',
                            'transport': 'ordinary-shared-protocol-dependency-not-a-third-business-module'},
              'remaining': ['real QQ/model accounts, old persona/private histories, production startup/autostart and installer switching are not performed',
                            'configuration applies at next service start; Stop service only stops the current resource and is not an implicit restart',
                            'context reset preserves old native histories, durable QQ deduplication and native ownership of already admitted work',
                            'automatic reconnect, cross-process QQ leases, hardware/research/download/player modules remain later work']}
    (ROOT / 'tests/modules/qq-phase-evidence.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
    return result
