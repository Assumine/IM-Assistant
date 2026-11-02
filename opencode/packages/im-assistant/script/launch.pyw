"""Windowless installed entry; the original Electron/CLI remain the application and service owners."""
import datetime
import json
import os
from pathlib import Path
import subprocess
import sys
from desktop_release import prepare_release

ROOT = Path(__file__).resolve().parents[4]


def configuration():
    record = json.loads((ROOT / 'upstream/opencode.json').read_text(encoding='utf-8'))
    bun = ROOT / record['runtime']['bun']
    desktop = ROOT / 'opencode/packages/desktop/out/main/index.js'
    if not bun.is_file() or not desktop.is_file():
        raise RuntimeError('缺少固定运行时或桌面构建文件，请先重新构建此安装。')
    return bun, ROOT / 'runtime/personal'


def launch():
    bun, profile = configuration()
    release = prepare_release(ROOT / 'opencode/packages/desktop')
    logdir = profile / 'launcher'
    logdir.mkdir(parents=True, exist_ok=True)
    environment = dict(os.environ)
    # Test diagnostics and development credentials must never enter the installed profile.
    for key in ['OPENCODE_DESKTOP_TEST_ROOT', 'OPENCODE_TEST_ONBOARDING', 'OPENCODE_TEST_HOME',
                'OPENCODE_DESKTOP_REMOTE_DEBUGGING_PORT', 'OPENCODE_DESKTOP_MEMORY_LOG']:
        environment.pop(key, None)
    environment['IM_ASSISTANT_DATA_ROOT'] = str(profile)
    environment['IM_ASSISTANT_PROFILE'] = 'personal'
    environment['IM_ASSISTANT_DESKTOP_RELEASE'] = str(release)
    environment['OPENCODE_DESKTOP_REMOTE_DEBUGGING_PORT'] = 'off'
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    with (logdir / f'desktop-{stamp}-{os.getpid()}.log').open('ab') as output:
        return subprocess.call([str(bun), 'run', 'script/desktop.ts'],
            cwd=ROOT / 'opencode/packages/im-assistant', env=environment,
            stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))


if __name__ == '__main__':
    try:
        if sys.argv[1:] == ['--check']:
            bun, profile = configuration()
            print(json.dumps({'ready': True, 'runtime': bun.relative_to(ROOT).as_posix(),
                              'profile': profile.relative_to(ROOT).as_posix(), 'starts_models_or_qq': False}))
            raise SystemExit(0)
        if sys.argv[1:]:
            raise RuntimeError('此桌面入口不接受任务、账号或文件参数。')
        raise SystemExit(launch())
    except Exception as error:
        if os.name == 'nt':
            import ctypes
            ctypes.windll.user32.MessageBoxW(None, str(error), '消息助手启动失败', 0x10)
        else:
            print(str(error), file=sys.stderr)
        raise SystemExit(1)
