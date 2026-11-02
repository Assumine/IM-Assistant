"""Current-user Windows entry cutover. Never imports legacy application code or copies its data."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
PROFILE = ROOT / 'runtime/personal'
PRIVATE = ROOT / 'runtime/deployment/desktop-entry'
CURRENT = PRIVATE / 'current.json'
TASK = 'IMAssistant-Autostart'
PYTHONW = ROOT / '.venv/Scripts/pythonw.exe'
LAUNCHER = ROOT / 'opencode/packages/im-assistant/script/launch.pyw'
ARGUMENTS = subprocess.list2cmdline([str(LAUNCHER)])
LEGACY = ROOT.parent


def digest(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()


def shell():
    import win32com.client
    return win32com.client.Dispatch('WScript.Shell')


def folder():
    import win32com.client
    service = win32com.client.Dispatch('Schedule.Service')
    service.Connect()
    return service, service.GetFolder('\\')


def link(file):
    value = shell().CreateShortcut(str(file))
    return {'target': value.TargetPath, 'arguments': value.Arguments, 'directory': value.WorkingDirectory}


def same(left, right):
    return os.path.normcase(os.path.abspath(left)) == os.path.normcase(os.path.abspath(right))


def is_new(value):
    return same(value['target'], PYTHONW) and value['arguments'] == ARGUMENTS


def task_action(task):
    actions = task.Definition.Actions
    if actions.Count != 1:
        raise RuntimeError('The startup task no longer has one owned action')
    action = actions.Item(1)
    return {'target': action.Path, 'arguments': action.Arguments, 'directory': action.WorkingDirectory}


def native():
    registration = PROFILE / 'native/state/opencode/service-im-assistant.json'
    record = json.loads(registration.read_text(encoding='utf-8'))
    if record['url'] != 'http://127.0.0.1:28716':
        raise RuntimeError('The installed entry does not own the expected local service')
    authorization = 'Basic ' + base64.b64encode(('opencode:' + record['password']).encode()).decode()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def read(path, data=None):
        request = urllib.request.Request(record['url'] + path,
            data=None if data is None else json.dumps(data).encode(),
            headers={'Authorization': authorization, 'Content-Type': 'application/json',
                     'x-opencode-directory': str(PROFILE / 'session-location')})
        with opener.open(request, timeout=10) as response:
            result = json.loads(response.read())
            return result['data'] if 'data' in result else result

    sessions = read('/api/session')
    modules = read('/api/rpc/experimental.capability/list', {'input': {}})['output']
    return {'native_sessions': len(sessions), 'modules': {item['id']: item['state'] for item in modules}}


def save(state):
    PRIVATE.mkdir(parents=True, exist_ok=True)
    temporary = CURRENT.with_suffix('.tmp')
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    os.replace(temporary, CURRENT)


def write_link(file):
    value = shell().CreateShortcut(str(file))
    value.TargetPath = str(PYTHONW)
    value.Arguments = ARGUMENTS
    value.WorkingDirectory = str(ROOT)
    value.IconLocation = str(ROOT / 'opencode/packages/desktop/icons/prod/icon.ico') + ',0'
    value.Description = '消息助手 · OpenCode 新版'
    value.Save()
    from win32com.propsys import propsys, pscon
    from win32com.shell import shell as windows_shell, shellcon
    store = propsys.SHGetPropertyStoreFromParsingName(str(file), None, shellcon.GPS_READWRITE, propsys.IID_IPropertyStore)
    store.SetValue(pscon.PKEY_AppUserModel_ID, propsys.PROPVARIANTType('tools.assumine.im-assistant'))
    store.Commit()
    windows_shell.SHChangeNotify(shellcon.SHCNE_UPDATEITEM, shellcon.SHCNF_PATHW, str(file), None)


def verify(*, check_runtime=True):
    state = json.loads(CURRENT.read_text(encoding='utf-8'))
    if state['status'] != 'applied':
        raise RuntimeError('This installation has no completed entry cutover')
    _, tasks = folder()
    task = tasks.GetTask(TASK)
    if task.Enabled != state['startup_enabled'] or not is_new(task_action(task)):
        raise RuntimeError('The startup action drifted from the installed entry')
    for item in state['links']:
        if not is_new(link(item['path'])):
            raise RuntimeError('An installed shortcut drifted from the new entry')
        if item['backup'] and digest(item['backup']) != item['sha256']:
            raise RuntimeError('An original shortcut backup changed')
    if digest(state['task_backup']) != state['task_sha256']:
        raise RuntimeError('The original startup backup changed')
    if digest(state['legacy_fallback']) != state['links'][0]['sha256']:
        raise RuntimeError('The explicit old-version fallback no longer matches the original shortcut')
    _, tasks = folder()
    sensor = tasks.GetTask('IMAssistant-CpuSensor')
    if sensor.Xml != state['sensor_xml']:
        raise RuntimeError('The unrelated sensor task changed')
    actual = native() if check_runtime else {}
    return {'status': 'passed', 'shortcut_count': len(state['links']), 'startup_replaced': True,
            'original_startup_enabled': state['startup_enabled'], 'original_backups_verified': True,
            'legacy_fallback_verified': True, 'unrelated_sensor_unchanged': True, **actual,
            'profile_is_separate': True, 'private_data_migrated': False, 'old_tasks_replayed': False}


def windows():
    """Read only the visible windows whose executable is this installation's Electron."""
    import win32com.client
    import win32gui
    import win32process
    executables = list((ROOT / 'opencode/node_modules/.bun').glob('electron@*/node_modules/electron/dist/electron.exe'))
    if len(executables) != 1:
        raise RuntimeError('The pinned Electron installation is ambiguous')
    owned = {int(item.ProcessId) for item in win32com.client.GetObject('winmgmts:').ExecQuery(
        'SELECT ProcessId, ExecutablePath FROM Win32_Process') if item.ExecutablePath and same(item.ExecutablePath, executables[0])}
    result = []

    def visit(handle, _):
        _, pid = win32process.GetWindowThreadProcessId(handle)
        if pid in owned and win32gui.IsWindowVisible(handle) and win32gui.GetWindowText(handle):
            left, top, right, bottom = win32gui.GetWindowRect(handle)
            if win32gui.IsIconic(handle):
                left, top, right, bottom = win32gui.GetWindowPlacement(handle)[4]
            if right - left > 300 and bottom - top > 200:
                result.append({'pid': pid, 'handle': handle, 'width': right - left, 'height': bottom - top})

    win32gui.EnumWindows(visit, None)
    return result


def apply():
    if CURRENT.exists():
        return verify()
    if not PYTHONW.is_file() or not LAUNCHER.is_file():
        raise RuntimeError('Prepare the new native launcher first')
    actual = native()
    if actual['native_sessions'] or set(actual['modules'].values()) != {'disabled'}:
        raise RuntimeError('Initial cutover requires the empty, optional-modules-off profile')
    sh = shell()
    primary = Path(sh.SpecialFolders('Programs')) / '消息助手.lnk'
    desktop = Path(sh.SpecialFolders('Desktop')) / '消息助手.lnk'
    fallback = primary.with_name('消息助手（旧版回退）.lnk')
    original = link(primary)
    if not same(original['target'], LEGACY / '.venv/Scripts/pythonw.exe') or str(LEGACY / 'management_center/launch_client.py') not in original['arguments']:
        raise RuntimeError('The primary shortcut is not the expected legacy assistant')
    if fallback.exists() or desktop.exists():
        raise RuntimeError('An existing shortcut would be overwritten; inspect it first')
    service, tasks = folder()
    task = tasks.GetTask(TASK)
    action = task_action(task)
    if task.State == 4 or not same(action['target'], LEGACY / '.venv/Scripts/pythonw.exe') or action['arguments'] != subprocess.list2cmdline([str(LEGACY / 'tray_app.py')]):
        raise RuntimeError('The startup task is running or no longer belongs to the old assistant')
    # Read-only process guard: no queue/database inspection, cancellation or process killing.
    import win32com.client
    wmi = win32com.client.GetObject('winmgmts:')
    for process in wmi.ExecQuery('SELECT ExecutablePath FROM Win32_Process'):
        executable = process.ExecutablePath
        if executable and str(executable).casefold().startswith(str(LEGACY / '.venv').casefold() + os.sep):
            raise RuntimeError('A legacy runtime is active; let its original owner finish before switching')
    backup = PRIVATE / ('backup-' + time.strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:8])
    backup.mkdir(parents=True)
    copy = backup / 'primary.lnk'
    shutil.copy2(primary, copy)
    task_file = backup / 'startup.xml'
    task_file.write_text(task.Xml, encoding='utf-16')
    state = {'status': 'prepared', 'startup_enabled': bool(task.Enabled), 'task_backup': str(task_file), 'task_sha256': digest(task_file),
        'sensor_xml': tasks.GetTask('IMAssistant-CpuSensor').Xml, 'legacy_fallback': str(fallback),
        'links': [{'path': str(primary), 'backup': str(copy), 'sha256': digest(copy)}, {'path': str(desktop), 'backup': None}]}
    save(state)
    try:
        shutil.copy2(copy, fallback)
        write_link(primary)
        write_link(desktop)
        definition = task.Definition
        definition.Actions.Item(1).Path = str(PYTHONW)
        definition.Actions.Item(1).Arguments = ARGUMENTS
        definition.Actions.Item(1).WorkingDirectory = str(ROOT)
        definition.RegistrationInfo.Description = '消息助手新版：使用原生 OpenCode 桌面；旧版保留回退，不自动搬迁旧任务。'
        tasks.RegisterTaskDefinition(TASK, definition, 6, None, None, 3)
        state['status'] = 'applied'
        save(state)
        return verify()
    except Exception:
        # The original is restored without running either assistant or its tasks.
        shutil.copy2(copy, primary)
        for file in [desktop, fallback]:
            if file.exists() and (is_new(link(file)) or file == fallback and digest(file) == digest(copy)):
                file.unlink()
        definition = service.NewTask(0)
        definition.XmlText = task_file.read_text(encoding='utf-16')
        tasks.RegisterTaskDefinition(TASK, definition, 6, None, None, 3)
        state['status'] = 'rolled-back'
        save(state)
        raise


def rollback():
    # Restoring verified entry files must also work when the new service failed to start.
    verify(check_runtime=False)
    state = json.loads(CURRENT.read_text(encoding='utf-8'))
    service, tasks = folder()
    for item in state['links']:
        if item['backup']:
            shutil.copy2(item['backup'], item['path'])
        else:
            Path(item['path']).unlink()
    definition = service.NewTask(0)
    definition.XmlText = Path(state['task_backup']).read_text(encoding='utf-16')
    tasks.RegisterTaskDefinition(TASK, definition, 6, None, None, 3)
    Path(state['legacy_fallback']).unlink()
    state['status'] = 'rolled-back'
    save(state)
    return {'restored': True, 'tasks_moved_or_replayed': False, 'applications_stopped': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['apply', 'verify', 'rollback'])
    args = parser.parse_args()
    print(json.dumps({'apply': apply, 'verify': verify, 'rollback': rollback}[args.action](), ensure_ascii=False))
