"""Verify and install the pinned portable download engine in this checkout only."""
from pathlib import Path
import argparse
import hashlib
import json
import subprocess
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def install(archive=None):
    info = json.loads((ROOT / 'upstream/aria2.json').read_text(encoding='utf-8'))
    target = ROOT / info['runtime']
    if archive is None:
        archive = ROOT / '.reports/downloads' / info['asset']
        archive.parent.mkdir(parents=True, exist_ok=True)
        if not archive.exists():
            with urllib.request.urlopen(info['url'], timeout=60) as response:
                data = response.read(20 * 1024 * 1024)
            archive.write_bytes(data)
    archive = Path(archive).resolve(strict=True)
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == info['archive_sha256'], 'Engine archive checksum mismatch'
    target.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as bundle:
        executable = [n for n in bundle.namelist() if n.endswith('/aria2c.exe')]
        assert len(executable) == 1
        data = bundle.read(executable[0])
        if not target.exists() or target.read_bytes() != data:
            target.write_bytes(data)
        for name in bundle.namelist():
            if Path(name).name in {'COPYING', 'AUTHORS', 'README.html'}:
                (target.parent / Path(name).name).write_bytes(bundle.read(name))
    probe = subprocess.run([str(target), '--version'], capture_output=True, text=True, encoding='utf-8',
        check=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    receipt = {'version': info['version'], 'archive_sha256': info['archive_sha256'],
        'executable_sha256': hashlib.sha256(target.read_bytes()).hexdigest(), 'relative_executable': info['runtime'],
        'actual_version': probe.stdout.splitlines()[0], 'global_install': False}
    (target.parent / 'verified.json').write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path)
    print(json.dumps(install(parser.parse_args().archive)))
