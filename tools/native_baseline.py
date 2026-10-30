"""Run original OpenCode commands in an isolated, non-production profile.

Development/test tooling only; this is not an application host or task scheduler.
"""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]


def provenance():
    return json.loads((ROOT / "upstream/opencode.json").read_text(encoding="utf-8"))


def environment(profile="build"):
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", profile):
        raise ValueError("Invalid baseline profile")
    record = provenance()
    bun = ROOT / record["runtime"]["bun"]
    node = ROOT / record["runtime"]["node"]
    if not bun.is_file() or not node.is_file():
        raise RuntimeError("Install the pinned local toolchain before running the baseline")
    home = ROOT / "runtime/baseline" / profile
    for part in ("tmp", "config", "data", "cache", "state", "Documents", "Desktop", "Downloads"):
        (home / part).mkdir(parents=True, exist_ok=True)
    allowed = {"SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "PROCESSOR_ARCHITECTURE",
               "NUMBER_OF_PROCESSORS", "PATH", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"}
    env = {k:v for k,v in os.environ.items() if k.upper() in allowed}
    env.update({
        "PATH":os.pathsep.join([str(bun.parent), str(node.parent), env.get("PATH", "")]),
        "HOME":str(home), "USERPROFILE":str(home), "APPDATA":str(home / "config"),
        "LOCALAPPDATA":str(home / "data"), "TMP":str(home / "tmp"),
        "TEMP":str(home / "tmp"), "TMPDIR":str(home / "tmp"),
        "XDG_CONFIG_HOME":str(home / "config"), "XDG_DATA_HOME":str(home / "data"),
        "XDG_CACHE_HOME":str(home / "cache"), "XDG_STATE_HOME":str(home / "state"),
        "BUN_INSTALL_CACHE_DIR":str(ROOT / "runtime/tools/bun-cache"), "HUSKY":"0",
        "BUN_RUNTIME_TRANSPILER_CACHE_PATH":str(ROOT / "runtime/tools/transpiler-cache"),
        "PLAYWRIGHT_BROWSERS_PATH":str(ROOT / "runtime/tools/playwright"),
        "DO_NOT_TRACK":"1", "OPENCODE_DISABLE_TELEMETRY":"1",
        "OPENCODE_DISABLE_MODELS_FETCH":"true", "OPENCODE_DISABLE_UPDATE_CHECK":"true",
        "OPENCODE_TEST_HOME":str(home),
    })
    return env


def run_command(directory, args, label, *, timeout=600, extra_env=None):
    root = (ROOT / "opencode").resolve()
    cwd = (root / directory).resolve()
    if not cwd.is_relative_to(root) or not cwd.is_dir():
        raise ValueError("Native command directory escapes the source tree")
    if not re.fullmatch(r"[a-z0-9-]+", label):
        raise ValueError("Invalid report label")
    record = provenance()
    env = environment()
    if extra_env:
        env.update(extra_env)
    log = ROOT / ".reports/native" / (label + ".log")
    log.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    with log.open("wb") as output:
        result = subprocess.run([str(ROOT / record["runtime"]["bun"]), *args],
                                cwd=cwd, env=env, stdout=output, stderr=subprocess.STDOUT,
                                timeout=timeout, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    content = log.read_text(encoding="utf-8", errors="replace")
    counts = re.search(r"\b(\d+) pass\s+.*?\b(\d+) fail", content, re.S)
    playwright = re.search(r"\b(\d+) passed\s*\(", content)
    skipped = re.search(r"\b(\d+) (?:skip|skipped)\b", content)
    receipt = {"args":["bun", *args], "cwd":str(cwd.relative_to(ROOT)).replace("\\", "/"),
               "source_commit":record["commit"], "exit_code":result.returncode,
               "duration_seconds":round(time.monotonic()-started, 2),
               "isolated_home":True, "log":str(log.relative_to(ROOT)).replace("\\", "/"),
               "native_tests_passed":int(counts[1]) if counts else int(playwright[1]) if playwright else None,
               "native_tests_failed":int(counts[2]) if counts else 0 if playwright and not result.returncode else None,
               "native_tests_skipped":int(skipped[1]) if skipped else 0}
    log.with_suffix(".json").write_text(json.dumps(receipt, indent=2)+"\n", encoding="utf-8")
    if result.returncode:
        raise RuntimeError(f"Native command failed: {label}; see {log.relative_to(ROOT)}")
    return receipt


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--label", required=True)
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("args", nargs=argparse.REMAINDER)
    options = parser.parse_args()
    args = options.args[1:] if options.args[:1] == ["--"] else options.args
    print(json.dumps(run_command(options.cwd, args, options.label, timeout=options.timeout)))
