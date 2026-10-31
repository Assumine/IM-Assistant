"""Verify the isolated whole-native backend adapter against the installed Codex CLI.

No production home, accounts, daemon or network model is used. Not an application host.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time

from tools.native_baseline import ROOT, environment, provenance


def run():
    checkpoint = ROOT / "upstream/codex-checkpoint.json"
    checkpoint.write_text(json.dumps({"schema_version": 1, "task": "R3-01", "status": "running", "publication": "disabled"}) + "\n", encoding="utf-8")
    try:
        return _run(checkpoint)
    except Exception:
        checkpoint.write_text(json.dumps({"schema_version": 1, "task": "R3-01", "status": "failed", "publication": "disabled", "evidence": ".reports/native/r3-native-tests.log"}) + "\n", encoding="utf-8")
        raise


def _run(checkpoint):
    executable = shutil.which("codex")
    if not executable:
        raise RuntimeError("Codex CLI is required; no skipped or synthetic queue acceptance")
    reports = ROOT / ".reports/native"
    reports.mkdir(parents=True, exist_ok=True)
    runtime = ROOT / "runtime/codex-native"
    runtime.mkdir(parents=True, exist_ok=True)
    test_root = Path(tempfile.mkdtemp(prefix="acceptance-", dir=runtime))
    env = environment("r3-native")
    env.update(IM_CODEX_EXECUTABLE=executable, IM_CODEX_TEST_ROOT=str(test_root))
    bun = str(ROOT / provenance()["runtime"]["bun"])
    module = ROOT / "modules/codex-native"
    started = time.monotonic()
    steps = []
    commands = [
        ("r3-native-types", [bun, str(ROOT / "opencode/node_modules/typescript/bin/tsc6"), "--project", "tsconfig.json"]),
        ("r3-native-tests", [bun, "test", "--timeout", "60000"]),
    ]
    for label, args in commands:
        log = reports / (label + ".log")
        with log.open("wb") as output:
            result = subprocess.run(args, cwd=module, env=env, stdout=output, stderr=subprocess.STDOUT,
                                    timeout=240, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        content = log.read_text(encoding="utf-8", errors="replace")
        counts = re.search(r"\b(\d+) pass\s+.*?\b(\d+) fail", content, re.S)
        steps.append({"label": label, "exit_code": result.returncode,
                      "passed": int(counts[1]) if counts else None,
                      "failed": int(counts[2]) if counts else None,
                      "skipped": sum(int(count) for count in re.findall(r"\b(\d+) (?:skip|skipped)\b", content)),
                      "log": log.relative_to(ROOT).as_posix()})
        if result.returncode:
            raise RuntimeError(f"Native adapter check failed: {label}; see {log.relative_to(ROOT)}\n{content[-7000:]}")
    if steps[-1]["passed"] != 6 or steps[-1]["failed"] != 0 or steps[-1]["skipped"] != 0:
        raise RuntimeError("Required six real-native scenarios did not all execute")
    version = subprocess.check_output([executable, "--version"], env=env, encoding="utf-8").strip()
    receipt = {
        "schema_version": 1, "task": "R3-01", "status": "partial_verified",
        "publication": "disabled", "native_cli_version": version,
        "native_cli_sha256": hashlib.sha256(Path(executable).read_bytes()).hexdigest(),
        "local_fixture_only": True, "production_credentials_used": False,
        "native_state_owner": "codex-app-server", "steps": steps,
        "sources": {file.relative_to(ROOT).as_posix(): hashlib.sha256(file.read_bytes()).hexdigest()
                    for file in sorted([*module.glob("src/*.ts"), *module.glob("test/*.ts"),
                                        module / "package.json", module / "tsconfig.json", Path(__file__).resolve()])},
        "duration_seconds": round(time.monotonic() - started, 2),
        "remaining": ["application whole-backend public host and native UI binding",
                      "cross-process single ownership via native application service",
                      "native queue/add is not idempotent by clientUserMessageId; host acceptance must prevent duplicate admission",
                      "real account connection and capability revalidation before publication"],
    }
    checkpoint.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    return receipt


if __name__ == "__main__":
    argparse.ArgumentParser(description=__doc__).parse_args()
    print(json.dumps(run(), indent=2))
