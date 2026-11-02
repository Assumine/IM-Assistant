"""Replay one agent-authored public-source branch using native SQLite and official MCP.

No real model inference, production credentials or browser is involved. One local
synthetic response holds a native input open for the authenticated MCP caller. The run
performs three live read-only GitHub requests, separated by the collector's 5 s cadence.
Use --interactive for an agent to author a new draft over JSON-lines tool commands.
"""
import argparse
import json
import subprocess

from tools.native_baseline import ROOT, environment, provenance, run_command


def run(interactive=False):
    profile = ROOT / 'runtime/baseline/research-public-test'
    profile.mkdir(parents=True, exist_ok=True)
    env = environment('research-public-test')
    env['IM_RESEARCH_PUBLIC_TEST_ROOT'] = str(profile)
    args = ['run', 'script/research-public-branch.ts']
    if interactive:
        return subprocess.call([str(ROOT / provenance()['runtime']['bun']), *args],
                               cwd=ROOT / 'opencode/packages/server', env=env)
    env['IM_RESEARCH_PUBLIC_TEST_REPLAY'] = '1'
    step = run_command('packages/server', args, 'research-public-branch', timeout=120, extra_env=env)
    lines = (ROOT / step['log']).read_text(encoding='utf-8').splitlines()
    result = next((json.loads(line.removeprefix('RESEARCH_CONSOLE ')) for line in reversed(lines)
                   if line.startswith('RESEARCH_CONSOLE ') and json.loads(line.removeprefix('RESEARCH_CONSOLE ')).get('status') == 'passed'), None)
    if not result:
        raise RuntimeError('No completed public-source proof; inspect ' + step['log'])
    report = result['report']
    if (len(report['checks']) != 7 or report['sourceRequestCount'] != 3 or report['toolErrors'] or
            report['modelApiRequests'] != 1 or report['realModelApiRequests'] or report['productionSwitch'] or report['duplicateExtraSourceRequests']):
        raise RuntimeError('Public-source proof did not meet its declared scope')
    output = ROOT / '.reports/research-public-branch.json'
    output.write_text(json.dumps({'step': step, 'result': report}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'status': 'passed', 'checks': len(report['checks']),
                      'sourceRequests': report['sourceRequestCount'], 'modelRequests': report['modelApiRequests'],
                      'evidence': output.relative_to(ROOT).as_posix()}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--interactive', action='store_true')
    raise SystemExit(run(parser.parse_args().interactive))
