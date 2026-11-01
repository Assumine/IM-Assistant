"""QQ chat ingress/reply/media acceptance against real native HTTP/SQLite and loopback only."""
import hashlib
import json
import tempfile

from tools.assistant_policy_smoke import policy_smoke
from tools.native_baseline import ROOT, run_command
from tools.qq_chatbot_smoke import acceptance as session_acceptance
from tools.qq_portal_smoke import _run
from tools.qq_protocol_smoke import module_check
from tools.verify_upstream import verify


def sources():
    previous = json.loads((ROOT / 'tests/modules/qq-chatbot-evidence.json').read_text(encoding='utf-8'))
    files = {ROOT / name for name in previous['sources']}
    for name in ['qq-chatbot', 'qq-protocol', 'qq-portal']:
        directory = ROOT / 'modules' / name
        files.update(directory.glob('src/*.ts'))
        files.update(directory.rglob('test/**/*.ts'))
        files.update(directory.glob('*.json'))
    files.update(ROOT / name for name in [
        'tools/qq_chatbot_channel_smoke.py', 'tests/modules/test_q1_03.py',
        'opencode/packages/server/script/qq-chatbot-channel-smoke.ts',
        'opencode/packages/core/src/session.ts', 'opencode/packages/core/src/session/session.ts',
        'opencode/packages/protocol/src/groups/session.ts', 'opencode/packages/protocol/test/experimental-identifiers.test.ts',
        'opencode/packages/server/src/handlers/session.ts', 'opencode/packages/server/src/middleware/runtime-policy.ts',
        'opencode/packages/client/script/generate.ts', 'opencode/packages/client/src/effect/api/api.ts',
        'opencode/packages/client/src/effect/generated/client.ts', 'opencode/packages/client/src/promise/generated/client.ts',
        'opencode/packages/client/src/promise/generated/types.ts', 'upstream/patches.json'])
    return {p.relative_to(ROOT).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(files)}


def acceptance(label):
    directory = tempfile.mkdtemp(prefix='qq-chat-channel-', dir=ROOT / 'runtime/baseline')
    step = run_command('packages/server', ['run', 'script/qq-chatbot-channel-smoke.ts'], label, timeout=180,
                       extra_env={'IM_QQ_CHAT_CHANNEL_ROOT': directory})
    lines = (ROOT / step['log']).read_text(encoding='utf-8').splitlines()
    result = json.loads([line for line in lines if line.startswith('{')][-1])
    if (result['status'] != 'passed' or len(result['checks']) != 12 or result['model_requests'] != 11 or
            result['loopback_send_attempts'] != 7 or result['actual_qq_connection'] or
            result['production_credentials_used'] or result['external_messages_sent'] or result['private_data_migrated']):
        raise RuntimeError('Native QQ chat channel acceptance was incomplete')
    return step, result


def run():
    before = sources()
    if not verify()['verified']:
        raise RuntimeError('Upstream patch provenance is invalid')
    print('Q1-03: shared transport/media and independent chat policy/reply boundaries', flush=True)
    compiler = str(ROOT / 'opencode/node_modules/typescript/bin/tsc6')
    steps = [module_check('qq-protocol', 'q3-channel-protocol-types', [compiler, '--project', 'tsconfig.json']),
             module_check('qq-protocol', 'q3-channel-protocol-unit', ['test'], 13),
             module_check('qq-protocol', 'q3-channel-media-stability', ['test', 'test/media.test.ts', '--rerun-each', '10'], 40),
             module_check('qq-chatbot', 'q3-channel-types', [compiler, '--project', 'tsconfig.json']),
             module_check('qq-chatbot', 'q3-channel-harness-types', [compiler, '--project', 'tsconfig.native.json']),
             module_check('qq-chatbot', 'q3-channel-unit', ['test'], 17)]
    print('Q1-03: native observation, reply switches, member mentions, controlled images and stop/restart', flush=True)
    step, native = acceptance('q3-channel-native')
    steps.append(step)
    stability = []
    for number in range(10):
        step, outcome = acceptance(f'q3-channel-stability-{number + 1}')
        stability.append(step)
        if outcome != native:
            raise RuntimeError('Native chat channel stability coverage drifted')
    print('Q1-03: previous native personality/history/compaction acceptance and API contracts', flush=True)
    step, sessions = session_acceptance('q3-channel-prior-sessions')
    steps.append(step)
    for package, args, label in [
        ('packages/protocol', ['test', 'test/experimental-identifiers.test.ts'], 'q3-channel-experimental-protocol'),
        ('packages/server', ['test', 'test/conversation-policy.test.ts'], 'q3-channel-managed-policy'),
        ('packages/core', ['run', 'script/test.ts', 'test/session-instructions.test.ts',
                          'test/instruction-state.test.ts', 'test/session-native-compaction.test.ts'], 'q3-channel-native-instructions'),
    ]:
        step = run_command(package, args, label)
        if not step['native_tests_passed'] or step['native_tests_failed'] or step['native_tests_skipped']:
            raise RuntimeError('Required native API/instruction checks did not execute')
        steps.append(step)
    managed = policy_smoke()
    if managed['denied_direct_apis'] != 15 or not managed['model_tool_catalog_empty'] or not managed['ambient_instructions_and_file_substitution_disabled']:
        raise RuntimeError('The managed file/tool capability boundary regressed')
    print('Q1-03: original QQ task forwarding, Codex adapter, native Session/Inbox and desktop compatibility', flush=True)
    qq = _run()
    original_tests = sum(step.get('passed', step.get('native_tests_passed', 0)) or 0 for step in qq['steps'])
    original_checks = sum(len(value['checks']) for key, value in qq.items() if key.endswith('_acceptance'))
    if original_tests != 699 or original_checks != 147:
        raise RuntimeError('Original QQ task forwarding coverage drifted')
    print('Q1-03: canonical native workspace check', flush=True)
    steps.append(run_command('.', ['run', 'check'], 'q3-channel-workspace', timeout=600))
    if '36 successful, 36 total' not in (ROOT / steps[-1]['log']).read_text(encoding='utf-8'):
        raise RuntimeError('Canonical workspace coverage incomplete')
    if sources() != before:
        raise RuntimeError('Acceptance sources changed during verification')
    unit = original_tests + sum(step.get('passed', step.get('native_tests_passed', 0)) or 0 for step in steps)
    result = {'schema_version': 1, 'plan_id': 'qq-plugin-migration-v1', 'task': 'Q1-03', 'status': 'passed',
              'publication': 'disabled', 'scope': 'isolated-chat-channel-not-default-product-or-live-rollout',
              'sources': before, 'steps': steps, 'native_acceptance': native, 'session_compatibility': sessions,
              'stability': {'steps': stability, 'runs': 10, 'chain_checks': 120, 'synthetic_model_requests': 110},
              'native_test_executions': unit, 'native_channel_checks': 12, 'native_session_checks': 17,
              'original_qq_tests': original_tests, 'original_qq_chain_checks': original_checks,
              'workspace_checks': 36, 'qq_compatibility': qq, 'managed_policy': managed,
              'actual_qq_connection': False, 'production_credentials_used': False, 'external_messages_sent': 0,
              'private_data_migrated': False, 'default_product_composition': False,
              'ownership': {'history': 'original-native-session-sqlite', 'queue': 'original-native-inbox',
                            'observations': 'original-native-synthetic-history-without-inbox-or-generation',
                            'persona_and_compaction': 'original-native-instructions-and-runner',
                            'metadata': 'plugin-kv-identities-switches-and-send-intent-receipts-only',
                            'transport': 'ordinary-shared-qq-protocol-dependency'},
              'remaining': ['actual product Capabilities.load/CLI/GUI settings and explicit profile/reset migration are Q1-04',
                            'no real Sheep account, old persona/private history or production launch entry was migrated',
                            'muted or unavailable image inputs retain not-interpreted markers; they are not claimed as visually understood',
                            'approved stickers require explicit inline assets; there is no implicit DSH/plugin-market migration',
                            'reconnect and cross-process account leases remain explicit; an unknown send is not automatically retried']}
    (ROOT / 'tests/modules/qq-chatbot-channel-evidence.json').write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
    return result
