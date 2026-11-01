"""Native standalone chatbot sessions/personality acceptance. Never use production accounts or histories."""
import hashlib
import json
import tempfile

from tools.assistant_policy_smoke import policy_smoke
from tools.native_baseline import ROOT, run_command
from tools.qq_portal_smoke import _run
from tools.qq_protocol_smoke import module_check
from tools.verify_upstream import verify


def sources():
    dependency = json.loads((ROOT / 'tests/modules/qq-protocol-evidence.json').read_text(encoding='utf-8'))
    files = {ROOT / name for name in dependency['sources']}
    directory = ROOT / 'modules/qq-chatbot'
    files.update(directory.rglob('*.ts'))
    files.update(directory.glob('*.json'))
    files.update(ROOT / name for name in [
        'tools/qq_chatbot_smoke.py', 'tools/assistant_policy_smoke.py', 'tools/native_api_smoke.py',
        'tests/modules/test_q1_02.py', 'opencode/packages/server/script/qq-chatbot-smoke.ts',
        'opencode/packages/server/src/middleware/runtime-policy.ts', 'opencode/packages/server/test/conversation-policy.test.ts',
        'opencode/packages/core/src/session/instruction-entry.ts', 'opencode/packages/core/src/session/instruction-state.ts',
        'opencode/packages/core/src/session/compaction.ts', 'opencode/packages/core/src/session/runner/llm.ts',
        'opencode/packages/core/test/session-instructions.test.ts', 'opencode/packages/core/test/instruction-state.test.ts',
        'opencode/packages/core/test/session-native-compaction.test.ts', 'upstream/patches.json'])
    return {p.relative_to(ROOT).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(files)}


def acceptance(label):
    directory = tempfile.mkdtemp(prefix='qq-chatbot-', dir=ROOT / 'runtime/baseline')
    step = run_command('packages/server', ['run', 'script/qq-chatbot-smoke.ts'], label, timeout=180,
                       extra_env={'IM_QQ_CHATBOT_TEST_ROOT': directory})
    lines = (ROOT / step['log']).read_text(encoding='utf-8').splitlines()
    result = json.loads([line for line in lines if line.startswith('{')][-1])
    if (result['status'] != 'passed' or len(result['checks']) != 17 or result['model_requests'] != 15 or
            result['shared_native_conversations'] != 5 or result['actual_qq_connection'] or
            result['production_credentials_used'] or result['external_messages_sent'] or result['private_data_migrated'] or
            result['configured_chat_transport']):
        raise RuntimeError('Standalone native chatbot acceptance was incomplete')
    return step, result


def run():
    before = sources()
    if not verify()['verified']:
        raise RuntimeError('Upstream patch provenance is invalid')
    print('Q1-02: independent module types and original API harness types', flush=True)
    # module_check already selects Bun; its first argument here is the pinned compiler script.
    compiler = str(ROOT / 'opencode/node_modules/typescript/bin/tsc6')
    steps = [module_check('qq-chatbot', 'q2-chatbot-types', [compiler, '--project', 'tsconfig.json']),
             module_check('qq-chatbot', 'q2-chatbot-harness-types', [compiler, '--project', 'tsconfig.native.json']),
             module_check('qq-chatbot', 'q2-chatbot-unit', ['test'], 7),
             module_check('qq-chatbot', 'q2-chatbot-unit-stability', ['test', 'test/configuration.test.ts', '--rerun-each', '10'], 70),
             module_check('qq-protocol', 'q2-chatbot-protocol-compatibility', ['test'], 9)]
    print('Q1-02: real native module/HTTP/SQLite/persona/member/compaction acceptance', flush=True)
    step, native = acceptance('q2-chatbot-native')
    steps.append(step)
    stability = []
    for number in range(10):
        step, outcome = acceptance(f'q2-chatbot-native-stability-{number + 1}')
        stability.append(step)
        if outcome['checks'] != native['checks']:
            raise RuntimeError('Native stability coverage drifted')
    print('Q1-02: native JSON instructions and managed file capability regressions', flush=True)
    steps.append(run_command('packages/server', ['test', 'test/conversation-policy.test.ts'], 'q2-chatbot-policy'))
    steps.append(run_command('packages/core', ['run', 'script/test.ts', 'test/session-instructions.test.ts',
                 'test/instruction-state.test.ts', 'test/session-native-compaction.test.ts'], 'q2-chatbot-core-instructions'))
    for step in steps[-2:]:
        if not step['native_tests_passed'] or step['native_tests_failed'] or step['native_tests_skipped']:
            raise RuntimeError('Required native instruction/policy scenarios did not execute')
    managed_policy = policy_smoke()
    if managed_policy['denied_direct_apis'] != 15 or not managed_policy['ambient_instructions_and_file_substitution_disabled']:
        raise RuntimeError('Managed project/file capability boundary regressed')
    print('Q1-02: original task forwarding/native Session/Inbox/backend compatibility', flush=True)
    qq = _run()
    compatibility_tests = sum(step.get('passed', step.get('native_tests_passed', 0)) or 0 for step in qq['steps'])
    compatibility_checks = sum(len(value['checks']) for key, value in qq.items() if key.endswith('_acceptance'))
    if compatibility_tests != 699 or compatibility_checks != 147:
        raise RuntimeError('Original task forwarding coverage drifted')
    print('Q1-02: canonical native workspace check', flush=True)
    steps.append(run_command('.', ['run', 'check'], 'q2-chatbot-workspace'))
    if '36 successful, 36 total' not in (ROOT / steps[-1]['log']).read_text(encoding='utf-8'):
        raise RuntimeError('Canonical workspace coverage incomplete')
    if sources() != before:
        raise RuntimeError('Acceptance sources changed while checks were running')
    unit = sum(step.get('passed', step.get('native_tests_passed', 0)) or 0 for step in steps) + compatibility_tests
    result = {'schema_version': 1, 'plan_id': 'qq-plugin-migration-v1', 'task': 'Q1-02', 'status': 'passed',
              'publication': 'disabled', 'scope': 'native-chat-module-foundation-not-live-chat-rollout',
              'sources': before, 'steps': steps, 'native_acceptance': native,
              'stability': {'steps': stability, 'runs': 10, 'chain_checks': 170, 'synthetic_model_requests': 150},
              'native_unit_executions': unit, 'native_chat_checks': 17, 'workspace_checks': 36,
              'original_qq_tests': compatibility_tests, 'original_qq_chain_checks': compatibility_checks,
              'qq_compatibility': qq, 'managed_policy': managed_policy,
              'actual_qq_connection': False, 'production_credentials_used': False, 'external_messages_sent': 0,
              'private_data_migrated': False, 'chat_transport_configured': False,
              'ownership': {'history': 'original-native-session-sqlite', 'queue': 'original-native-inbox',
                            'persona': 'original-native-api-managed-instruction-entry',
                            'context_and_compaction': 'original-native-runner',
                            'metadata': 'module-private-plugin-kv-identities-and-fingerprints-only'},
              'remaining': ['QQ raw-event policy, reply switches, structured mentions and images are Q1-03',
                            'production composition, actual settings and explicit profile/reset migration are Q1-04',
                            'this phase does not connect the real Sheep account, import private histories or publish a live chat service',
                            'unproven/withdrawn native input is reconciled only; deleted native history is never recreated on replay']}
    output = ROOT / 'tests/modules/qq-chatbot-evidence.json'
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
    return result
