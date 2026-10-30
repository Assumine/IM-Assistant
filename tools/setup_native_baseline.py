"""Install the locked Windows x64 development toolchain locally, not on PATH globally."""
import argparse
import hashlib
import json
import os
from pathlib import PurePosixPath
import shutil
import subprocess
import urllib.request
import zipfile

from tools.native_baseline import ROOT, environment, provenance, run_command
from tools.verify_upstream import verify


def install_archive(url, expected, filename, destination):
    downloads = ROOT / ".reports/downloads"
    downloads.mkdir(parents=True, exist_ok=True)
    archive = downloads / filename
    if not archive.is_file():
        partial = archive.with_suffix(".partial")
        request = urllib.request.Request(url, headers={"User-Agent": "IM-Assistant-baseline"})
        with urllib.request.urlopen(request, timeout=60) as source, partial.open("wb") as output:
            shutil.copyfileobj(source, output, 1024 * 1024)
        os.replace(partial, archive)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
        raise ValueError("Toolchain archive checksum mismatch: " + filename)
    tools = (ROOT / "runtime/tools").resolve()
    assert destination.resolve().is_relative_to(tools)
    with zipfile.ZipFile(archive) as zipped:
        for item in zipped.infolist():
            parts = PurePosixPath(item.filename)
            if parts.is_absolute() or ".." in parts.parts:
                raise ValueError("Unsafe toolchain archive entry")
            target = destination.joinpath(*parts.parts)
            assert target.resolve().is_relative_to(tools)
            if item.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                data = zipped.read(item)
                if not target.is_file() or target.read_bytes() != data:
                    target.write_bytes(data)


def setup():
    if os.name != "nt" or os.environ.get("PROCESSOR_ARCHITECTURE", "").upper() != "AMD64":
        raise RuntimeError("This baseline toolchain is pinned for Windows x64; other platforms need their own reviewed record")
    print(json.dumps(verify()), flush=True)
    record = provenance()
    runtime = record["runtime"]
    bun_version = record["package_manager"].split("@", 1)[1]
    install_archive(f"https://github.com/oven-sh/bun/releases/download/bun-v{bun_version}/bun-windows-x64-baseline.zip",
        runtime["bun_archive_sha256"], "bun-windows-x64-baseline.zip", ROOT / "runtime/tools" / ("bun-" + bun_version))
    install_archive(runtime["node_origin"], runtime["node_archive_sha256"],
        runtime["node_origin"].rsplit("/", 1)[1], ROOT / "runtime/tools")
    for command, expected in (([str(ROOT / runtime["bun"]), "--version"], bun_version),
                              ([str(ROOT / runtime["node"]), "--version"], runtime["node_version"])):
        result = subprocess.run(command, env=environment(), capture_output=True, text=True, check=True)
        assert result.stdout.strip() == expected
    print(json.dumps(run_command(".", ["install", "--frozen-lockfile"], "install")), flush=True)
    print(json.dumps(run_command("packages/desktop", ["run", "install-electron"], "electron-install")), flush=True)
    print(json.dumps(run_command("packages/desktop", ["run", "script/copy-icons.ts", "dev"], "desktop-icons")), flush=True)
    print(json.dumps(run_command("packages/app", ["x", "playwright", "install", "chromium"], "playwright-install")), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    setup()
