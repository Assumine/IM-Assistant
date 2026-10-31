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
    if steps[-1]["passed"] != 13 or steps[-1]["failed"] != 0 or steps[-1]["skipped"] != 0:
        raise RuntimeError("Required thirteen real-native scenarios did not all execute")
    core_files = ["test/conversation-backend.test.ts", "test/kv.test.ts", "test/rpc-handler-errors.test.ts"]
    server_files = ["test/conversation-policy.test.ts", "test/rpc-handler-errors.test.ts"]
    for directory, files, label, count in [
        ("packages/core", core_files, "r3-host-unit", 19),
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
    if host["status"] != "passed" or len(host["checks"]) != 10 or host["model_requests"] != 4:
        raise RuntimeError("Native application HTTP/SQLite acceptance was incomplete")
    tabs = run_command("packages/app", ["test", "--conditions=solid", "--preload", "../ui/test/solid-jsx.ts",
        "--preload", "./happydom.ts", "./src/shell/tabs/tabs.test.ts", "./src/shell/state/layout.test.ts",
        "./src/shell/routes/session.test.ts", "./src/shell/notifications/notification.test.ts",
        "./src/shell/titlebar/tab-order.test.ts"], "r3-tabs-unit")
    if tabs["native_tests_passed"] != 42 or tabs["native_tests_failed"] or tabs["native_tests_skipped"]:
        raise RuntimeError("Required native shell tab scenarios did not execute")
    steps.append(tabs)
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    browser = run_command("packages/app", ["x", "--no-install", "playwright", "test", "e2e/regression/settings.spec.ts",
        "e2e/regression/tabs.spec.ts", "e2e/regression/session-queue.spec.ts", "e2e/regression/composer.spec.ts", "--grep", "backends:|tabs.spec.ts|session-queue.spec.ts|composer.spec.ts", "--project", "chromium", "--workers", "2", "--retries", "0"], "r3-backend-browser",
        extra_env={"PLAYWRIGHT_BUILD": "1", "PLAYWRIGHT_PORT": str(port)})
    if browser["native_tests_passed"] != 129 or browser["native_tests_failed"] or browser["native_tests_skipped"]:
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
        "packages/gui-plugins/src/backends/browser.tsx",
        "packages/gui-plugins/src/backends/execution.tsx",
        "packages/app/src/runtime/plugin/ui.tsx", "packages/app/src/session/composer/queue-panel.tsx",
        "packages/app/e2e/regression/session-queue.spec.ts",
        "packages/app/src/composer/backend.tsx", "packages/app/src/composer/state.ts",
        "packages/app/src/composer/queue-draft.ts", "packages/app/src/session/composer/queue.ts",
        "packages/app/src/composer/editor/editor.tsx", "packages/app/src/composer/editor/interaction.ts",
        "packages/app/e2e/utils/drafts.ts",
        "packages/app/e2e/regression/composer.spec.ts",
        "packages/app/e2e/utils/backends.ts", "packages/app/e2e/utils/mock-server.ts",
        "packages/app/e2e/regression/settings.spec.ts",
        "packages/app/e2e/regression/tabs.spec.ts", "packages/app/component-tests/plugin-host.fixture.tsx",
        "packages/plugin/src/gui/host-apis.ts", "packages/plugin/src/gui/registries.ts",
        "packages/gui-plugins/src/backends/room.tsx", "packages/gui-plugins/src/main.ts", "packages/gui-plugins/README.md",
        "packages/app/src/runtime/i18n/en.ts", "packages/app/src/runtime/plugin/backend-view.tsx",
        "packages/app/src/runtime/plugin/host-apis.tsx", "packages/app/src/runtime/plugin/server-shell.tsx",
        "packages/app/src/shell/tabs/schema.ts", "packages/app/src/shell/tabs/tabs.tsx",
        "packages/app/src/shell/tabs/tabs.test.ts", "packages/app/src/shell/tabs/closed.ts",
        "packages/app/src/shell/state/layout.tsx", "packages/app/src/shell/state/layout.test.ts",
        "packages/app/src/shell/routes/session.ts", "packages/app/src/shell/routes/session.test.ts",
        "packages/app/src/shell/routes/routes.tsx", "packages/app/src/shell/notifications/notification.test.ts",
        "packages/app/src/shell/titlebar/tab-strip.tsx", "packages/app/src/shell/titlebar/tab-nav.tsx",
        "packages/app/src/shell/titlebar/titlebar.tsx", "packages/app/src/shell/titlebar/recently-closed-tabs-menu.tsx",
        "packages/app/src/shell/titlebar/tab-order.test.ts",
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
        "remaining": ["native direct-steer, per-token live-text UI and production host activation; native queue update/confirmed withdrawal, editor submission and committed draft/handoff recovery verified with fixtures",
                      "shared transport is experimental and not published; production activation and OS matrix remain unverified",
                      "uncertain handoff with no native evidence requires manual reconciliation; never automatically replay",
                      "real account connection and capability revalidation before publication"],
    }
    checkpoint.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    return receipt


if __name__ == "__main__":
    argparse.ArgumentParser(description=__doc__).parse_args()
    print(json.dumps(run(), indent=2))
