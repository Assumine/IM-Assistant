"""Immutable, content-addressed desktop resources for the installed launcher.

Keep snapshots under the desktop package so native dependencies resolve from the
original node_modules. Never copy profiles or dependencies, and never prune an
output that a running Electron process may still be using.
"""
import hashlib
import json
from pathlib import Path
import shutil
import tempfile


def inventory(desktop):
    desktop = Path(desktop).resolve()
    required = ['package.json', 'out/main/index.js', 'out/preload/index.cjs', 'out/renderer/index.html']
    if any(not (desktop / name).is_file() for name in required):
        raise RuntimeError('桌面构建不完整，请先完成构建。')
    paths = [desktop / 'package.json']
    for name in ['out', 'resources']:
        paths.extend(p for p in (desktop / name).rglob('*') if p.is_file())
    result = {}
    for file in sorted(paths):
        if not file.resolve().is_relative_to(desktop) or file.is_symlink():
            raise RuntimeError('桌面构建包含越界链接，未创建启动快照。')
        result[file.relative_to(desktop).as_posix()] = hashlib.sha256(file.read_bytes()).hexdigest()
    return result


def prepare_release(desktop):
    desktop = Path(desktop).resolve()
    files = inventory(desktop)
    identity = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()
    releases = desktop / '.im-releases'
    releases.mkdir(exist_ok=True)
    if releases.resolve() != releases:
        raise RuntimeError('桌面快照目录不可使用外部链接。')
    target = releases / identity
    if target.exists():
        if inventory(target) != files:
            raise RuntimeError('已安装的桌面快照不完整，未覆盖运行资源。')
        return target
    staging = Path(tempfile.mkdtemp(prefix='.staging-', dir=releases))
    try:
        for name in files:
            dest = staging / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(desktop / name, dest)
        if inventory(staging) != files or inventory(desktop) != files:
            raise RuntimeError('桌面构建正在变化，请在构建结束后重新打开。')
        try:
            staging.rename(target)
        except FileExistsError:
            # Simultaneous shortcut activation can publish the same immutable bytes.
            if inventory(target) != files:
                raise RuntimeError('另一启动进程创建了不完整的快照。')
        return target
    finally:
        if staging.exists():
            shutil.rmtree(staging)
