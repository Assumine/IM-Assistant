"""Verify the isolated whole-native backend adapter against the installed Codex CLI.

No production home, accounts, daemon or network model is used. Not an application host.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile
import time

from tools.native_baseline import ROOT, environment, provenance, run_command


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
    if steps[-1]["passed"] != 11 or steps[-1]["failed"] != 0 or steps[-1]["skipped"] != 0:
        raise RuntimeError("Required eleven real-native scenarios did not all execute")
    core_files = ["test/conversation-backend.test.ts", "test/kv.test.ts", "test/rpc-handler-errors.test.ts"]
    server_files = ["test/conversation-policy.test.ts", "test/rpc-handler-errors.test.ts"]
    for directory, files, label, count in [
        ("packages/core", core_files, "r3-host-unit", 17),
        ("packages/server", server_files, "r3-host-server-unit", 3),
    ]:
        if not all((ROOT / "opencode" / directory / name).is_file() for name in files):
            raise RuntimeError("Required native test file is missing")
        result = run_command(directory, ["test", *files], label)
        if result["native_tests_passed"] != count or result["native_tests_failed"] or result["native_tests_skipped"]:
            raise RuntimeError(f"Required native test scenarios did not execute: {label}")
        steps.append(result)
    steps.append(run_command("packages/server", ["run", "script/codex-backend-smoke.ts"], "r3-host-http",
                             extra_env={"IM_CODEX_EXECUTABLE": executable, "IM_CODEX_TEST_ROOT": str(test_root)}))
    output = (reports / "r3-host-http.log").read_text(encoding="utf-8")
    host = json.loads(next(line for line in reversed(output.splitlines()) if line.startswith('{"status":')))
    if host["status"] != "passed" or len(host["checks"]) != 8 or host["model_requests"] != 4:
        raise RuntimeError("Native application HTTP/SQLite acceptance was incomplete")
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    browser = run_command("packages/app", ["x", "--no-install", "playwright", "test", "e2e/regression/settings.spec.ts",
        "--grep", "backends:", "--project", "chromium", "--workers", "2", "--retries", "0"], "r3-backend-browser",
        extra_env={"PLAYWRIGHT_BUILD": "1", "PLAYWRIGHT_PORT": str(port)})
    if browser["native_tests_passed"] != 6 or browser["native_tests_failed"] or browser["native_tests_skipped"]:
        raise RuntimeError("Required backend settings browser scenarios did not execute")
    steps.append(browser)
    steps.append(run_command(".", ["run", "check"], "r3-host-check"))
    version = subprocess.check_output([executable, "--version"], env=env, encoding="utf-8").strip()
    app_sources = [
        "packages/schema/src/conversation-backend.ts", "packages/plugin/src/effect/conversation.ts",
        "packages/plugin/src/effect/plugin.ts", "packages/core/src/conversation-backend.ts",
        "packages/core/src/kv.ts", "packages/core/src/plugin/host.ts",
        "packages/core/test/conversation-backend.test.ts", "packages/core/test/plugin/fixture.ts",
        "packages/server/src/middleware/runtime-policy.ts", "packages/server/src/routes.ts",
        "packages/server/test/conversation-policy.test.ts", "packages/server/script/codex-backend-smoke.ts",
        "packages/gui-plugins/src/conversation.ts", "packages/gui-plugins/src/renderer.ts",
        "packages/gui-plugins/src/backends/index.ts", "packages/gui-plugins/src/backends/renderer.tsx",
        "packages/gui-plugins/src/backends/page.tsx", "packages/gui-plugins/src/backends/i18n/en.ts",
        "packages/app/e2e/utils/backends.ts", "packages/app/e2e/utils/mock-server.ts",
        "packages/app/e2e/regression/settings.spec.ts",
    ]
    receipt = {
        "schema_version": 1, "task": "R3-01", "status": "partial_verified",
        "publication": "disabled", "native_cli_version": version,
        "native_cli_sha256": hashlib.sha256(Path(executable).read_bytes()).hexdigest(),
        "local_fixture_only": True, "production_credentials_used": False,
        "native_state_owner": "codex-app-server", "steps": steps,
        "host_acceptance": host,
        "sources": {file.relative_to(ROOT).as_posix(): hashlib.sha256(file.read_bytes()).hexdigest()
                    for file in sorted([*module.glob("src/*.ts"), *module.rglob("test/**/*.ts"),
                                        module / "package.json", module / "tsconfig.json", Path(__file__).resolve(),
                                        *(ROOT / "opencode" / name for name in app_sources)])},
        "duration_seconds": round(time.monotonic() - started, 2),
        "remaining": ["native conversation/timeline UI binding and production host activation; settings selection/sign-in UI verified with fixtures",
                      "shared transport is experimental and not published; production activation and OS matrix remain unverified",
                      "uncertain handoff with no native evidence requires manual reconciliation; never automatically replay",
                      "real account connection and capability revalidation before publication"],
    }
    checkpoint.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    return receipt


if __name__ == "__main__":
    argparse.ArgumentParser(description=__doc__).parse_args()
    print(json.dumps(run(), indent=2))
