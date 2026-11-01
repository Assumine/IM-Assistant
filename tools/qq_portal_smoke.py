"""Isolated QQ ingress slice verification. Never connects to QQ or sends an external message."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

from tools.native_baseline import ROOT, environment, provenance, run_command


def run():
    checkpoint = ROOT / "upstream/qq-checkpoint.json"
    checkpoint.write_text(json.dumps({"task": "R3-02", "status": "running", "publication": "disabled"}) + "\n", encoding="utf-8", newline="\n")
    try:
        result = _run()
        checkpoint.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8", newline="\n")
        return result
    except Exception:
        checkpoint.write_text(json.dumps({"task": "R3-02", "status": "failed", "publication": "disabled"}) + "\n", encoding="utf-8", newline="\n")
        raise


def _run():
    executable = shutil.which("codex")
    if not executable:
        raise RuntimeError("Codex CLI is required; native target acceptance cannot be skipped")
    module = ROOT / "modules/qq-portal"
    reports = ROOT / ".reports/native"
    reports.mkdir(parents=True, exist_ok=True)
    parent = ROOT / "runtime/baseline"
    parent.mkdir(parents=True, exist_ok=True)
    directory = tempfile.mkdtemp(prefix="qq-acceptance-", dir=parent)
    bun = str(ROOT / provenance()["runtime"]["bun"])
    steps = []
    for module_directory, label, args, expected_count in [
        (module, "r3-qq-module-types", [bun, str(ROOT / "opencode/node_modules/typescript/bin/tsc6"), "--project", "tsconfig.json"], None),
        (module, "r3-qq-module-tests", [bun, "test"], 145),
        (ROOT / "modules/codex-native", "r3-qq-native-guidance-input", [bun, "test", "test/input.test.ts"], 5),
    ]:
        log = reports / (label + ".log")
        with log.open("wb") as output:
            process = subprocess.run(args, cwd=module_directory, env=environment("qq-ingress"), stdout=output, stderr=subprocess.STDOUT,
                                     timeout=120, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        content = log.read_text(encoding="utf-8", errors="replace")
        counts = re.search(r"\b(\d+) pass\s+.*?\b(\d+) fail", content, re.S)
        skipped = sum(map(int, re.findall(r"\b(\d+) (?:skip|skipped)\b", content)))
        if process.returncode or skipped or expected_count is not None and (not counts or (int(counts[1]), int(counts[2])) != (expected_count, 0)):
            raise RuntimeError(f"QQ module check failed: {label}; see {log.relative_to(ROOT)}")
        steps.append({"label": label, "exit_code": process.returncode, "passed": int(counts[1]) if counts else None, "skipped": skipped, "log": log.relative_to(ROOT).as_posix()})
    steps.append(run_command("packages/server", ["run", "script/qq-portal-smoke.ts"], "r3-qq-http", timeout=180,
                             extra_env={"IM_QQ_TEST_ROOT": directory}))
    lines = (reports / "r3-qq-http.log").read_text(encoding="utf-8").splitlines()
    http = json.loads(next(line for line in reversed(lines) if line.startswith('{"status":')))
    if http["status"] != "passed" or len(http["checks"]) != 31 or http["model_requests"] != 7 or http["actual_qq_connection"] or http["external_messages_sent"]:
        raise RuntimeError("QQ original SDK/HTTP/SQLite acceptance was incomplete")
    wire_directory = tempfile.mkdtemp(prefix="qq-wire-", dir=parent)
    steps.append(run_command("packages/server", ["run", "script/qq-wire-smoke.ts"], "r3-qq-wire-http", timeout=180,
                             extra_env={"IM_QQ_WIRE_TEST_ROOT": wire_directory}))
    lines = (reports / "r3-qq-wire-http.log").read_text(encoding="utf-8").splitlines()
    wire = json.loads(next(line for line in reversed(lines) if line.startswith('{"status":')))
    if (wire["status"] != "passed" or len(wire["checks"]) != 11 or wire["model_requests"] != 2 or
            wire["actual_qq_connection"] or wire["external_messages_sent"] or wire["production_credentials_used"] or
            wire["loopback_messages_sent"] != 2 or wire["loopback_connection_attempts"] != 3 or
            wire["lifecycle"] != "explicit-owner-effect-scope"):
        raise RuntimeError("Authenticated loopback OneBot/native SDK acceptance was incomplete")
    product_directory = tempfile.mkdtemp(prefix="qq-product-", dir=parent)
    steps.append(run_command("packages/server", ["run", "script/qq-product-smoke.ts"], "r3-qq-product-http", timeout=180,
                             extra_env={"IM_QQ_PRODUCT_TEST_ROOT": product_directory}))
    lines = (reports / "r3-qq-product-http.log").read_text(encoding="utf-8").splitlines()
    product = json.loads(next(line for line in reversed(lines) if line.startswith('{"status":')))
    if (product["status"] != "passed" or len(product["checks"]) != 9 or product["model_requests"] != 2 or
            product["actual_qq_connection"] or product["external_messages_sent"] or product["production_credentials_used"] or
            product["loopback_connection_attempts"] != 2 or product["automatic_replies"] or
            product["product_entry"] != "packages/im-assistant/src/cli.ts"):
        raise RuntimeError("QQ actual product entry acceptance was incomplete")
    steps.append(run_command("packages/server", ["test", "--timeout", "30000", "test/application-modules.test.ts",
                             "test/process.test.ts", "test/fetch.test.ts"], "r3-qq-product-host-regression", timeout=180))
    if steps[-1]["native_tests_passed"] != 20 or steps[-1]["native_tests_failed"] or steps[-1]["native_tests_skipped"]:
        raise RuntimeError("Application-scoped ownership and original server regressions did not all execute")
    native_parent = ROOT / "runtime/codex-native"
    native_parent.mkdir(parents=True, exist_ok=True)
    native_directory = tempfile.mkdtemp(prefix="qq-backend-", dir=native_parent)
    steps.append(run_command("packages/server", ["run", "script/qq-backend-smoke.ts"], "r3-qq-native-http", timeout=180,
                             extra_env={"IM_CODEX_EXECUTABLE": executable, "IM_QQ_BACKEND_TEST_ROOT": native_directory}))
    lines = (reports / "r3-qq-native-http.log").read_text(encoding="utf-8").splitlines()
    native = json.loads(next(line for line in reversed(lines) if line.startswith('{"status":')))
    if native["status"] != "passed" or len(native["checks"]) != 18 or native["model_requests"] != 4 or native["native_admissions"] != 6 or native["actual_qq_connection"] or native["external_messages_sent"] or native["production_credentials_used"]:
        raise RuntimeError("QQ real native backend target acceptance was incomplete")
    continuation_directory = tempfile.mkdtemp(prefix="qq-continuation-", dir=parent)
    steps.append(run_command("packages/server", ["run", "script/qq-continuation-smoke.ts"], "r3-qq-continuation-http", timeout=180,
                             extra_env={"IM_QQ_CONTINUATION_TEST_ROOT": continuation_directory}))
    lines = (reports / "r3-qq-continuation-http.log").read_text(encoding="utf-8").splitlines()
    continuation = json.loads(next(line for line in reversed(lines) if line.startswith('{"status":')))
    if continuation["status"] != "passed" or len(continuation["checks"]) != 7 or continuation["model_requests"] != 6 or continuation["actual_qq_connection"] or continuation["external_messages_sent"] or continuation["production_credentials_used"]:
        raise RuntimeError("Native guarded continuation acceptance was incomplete")
    guidance_directory = tempfile.mkdtemp(prefix="qq-guidance-", dir=native_parent)
    steps.append(run_command("packages/server", ["run", "script/qq-backend-continuation-smoke.ts"], "r3-qq-native-guidance-http", timeout=180,
                             extra_env={"IM_CODEX_EXECUTABLE": executable, "IM_QQ_GUIDANCE_TEST_ROOT": guidance_directory}))
    lines = (reports / "r3-qq-native-guidance-http.log").read_text(encoding="utf-8").splitlines()
    guidance = json.loads(next(line for line in reversed(lines) if line.startswith('{"status":')))
    if guidance["status"] != "passed" or len(guidance["checks"]) != 8 or guidance["model_requests"] != 3 or guidance["native_admissions"] != 5 or guidance["actual_qq_connection"] or guidance["external_messages_sent"] or guidance["production_credentials_used"]:
        raise RuntimeError("Real native guarded guidance acceptance was incomplete")
    linked_directory = tempfile.mkdtemp(prefix="qq-native-followup-", dir=native_parent)
    steps.append(run_command("packages/server", ["run", "script/qq-native-followup-smoke.ts"], "r3-qq-native-followup-http", timeout=180,
                             extra_env={"IM_CODEX_EXECUTABLE": executable, "IM_QQ_NATIVE_FOLLOWUP_ROOT": linked_directory}))
    lines = (reports / "r3-qq-native-followup-http.log").read_text(encoding="utf-8").splitlines()
    linked = json.loads(next(line for line in reversed(lines) if line.startswith('{"status":')))
    if linked["status"] != "passed" or len(linked["checks"]) != 8 or linked["model_requests"] != 4 or linked["native_admissions"] != 7 or linked["followup_calls"] != 5 or linked["actual_qq_connection"] or linked["external_messages_sent"] or linked["production_credentials_used"]:
        raise RuntimeError("Real native linked follow-up acceptance was incomplete")
    for package, files, label, count, filters in [
        ("sdk", ["test/instances.test.ts", "test/instances-effect.test.ts"], "r3-qq-sdk-regression", 8, []),
        ("core", ["test/session-input.test.ts", "test/session-inbox-append.test.ts", "test/session-owned.test.ts", "test/session-prompt.test.ts"], "r3-qq-append-session-regression", 93, []),
        ("core", ["test/session-execution.test.ts", "test/session-runner.test.ts", "test/session-native.test.ts", "test/session-native-compaction.test.ts"], "r3-qq-continuation-required-runner", 290, []),
        ("client", ["test/solid-inbox-race.test.ts"], "r3-qq-append-client-unit", 10, []),
    ]:
        if not all((ROOT / "opencode/packages" / package / name).is_file() for name in files):
            raise RuntimeError("Required original SDK regression file is absent")
        # Keep test-only temporary locations outside this Git checkout.
        with tempfile.TemporaryDirectory(prefix="qq-original-regression-") as temporary:
            result = run_command("packages/" + package, ["test", "--timeout", "30000", *files, *filters], label,
                                 extra_env={"TMP": temporary, "TEMP": temporary, "TMPDIR": temporary})
        if result["native_tests_passed"] != count or result["native_tests_failed"] or result["native_tests_skipped"]:
            raise RuntimeError("Required original SDK regression scenarios did not all execute")
        steps.append(result)
    steps.append(run_command("packages/core", ["test", "test/conversation-backend.test.ts"], "r3-qq-native-guidance-core"))
    if steps[-1]["native_tests_passed"] != 19 or steps[-1]["native_tests_failed"] or steps[-1]["native_tests_skipped"]:
        raise RuntimeError("Required native input identity checks did not all execute")
    names = [
        "opencode/packages/core/src/plugin/host.ts", "opencode/packages/core/src/plugin/sdk.ts", "opencode/packages/core/src/plugin/supervisor.ts",
        "opencode/packages/plugin/src/effect/storage.ts", "opencode/packages/plugin/src/promise/storage.ts", "opencode/packages/plugin/src/promise/adapter.ts",
        "opencode/packages/sdk/src/internal/host.ts", "opencode/packages/sdk/src/promise.ts", "opencode/packages/server/script/qq-portal-smoke.ts",
        "opencode/packages/server/test/vcs.test.ts", "tools/qq_portal_smoke.py",
        "opencode/packages/core/test/plugin/host.ts", "opencode/packages/core/test/plugin/goal-watchdog.test.ts",
        "opencode/packages/simulation/test/simulated-provider.test.ts",
        "opencode/packages/server/script/qq-backend-smoke.ts", "opencode/packages/schema/src/conversation-backend.ts",
        "opencode/packages/core/src/conversation-backend.ts", "opencode/packages/core/test/conversation-backend.test.ts",
        "opencode/packages/server/src/middleware/runtime-policy.ts", "opencode/packages/server/test/conversation-policy.test.ts",
        "opencode/packages/schema/src/session-inbox.ts", "opencode/packages/schema/src/session-event.ts",
        "opencode/packages/core/src/session/inbox.ts", "opencode/packages/core/src/session/session.ts", "opencode/packages/core/src/session.ts",
        "opencode/packages/core/src/session/projector.ts", "opencode/packages/core/src/session/message-updater.ts",
        "opencode/packages/core/test/session-inbox-append.test.ts", "opencode/packages/core/test/session-owned.test.ts", "opencode/packages/core/test/session-prompt.test.ts",
        "opencode/packages/client/src/solid/data.ts", "opencode/packages/client/test/solid-inbox-race.test.ts",
        "opencode/packages/client/src/promise/generated/types.ts", "opencode/packages/client/src/promise/generated/client.ts",
        "opencode/packages/client/src/effect/generated/client.ts", "opencode/packages/client/src/effect/api/api.ts",
        "opencode/packages/protocol/src/groups/session.ts", "opencode/packages/server/src/handlers/session.ts",
        "opencode/packages/app/src/runtime/server/data.ts", "opencode/packages/app/e2e/regression/session-queue.spec.ts",
        "opencode/packages/core/src/session/input.ts", "opencode/packages/core/src/session/execution.ts", "opencode/packages/core/src/session/runner/llm.ts",
        "opencode/packages/core/test/session-input.test.ts", "opencode/packages/core/test/session-execution.test.ts", "opencode/packages/core/test/session-runner.test.ts",
        "opencode/packages/core/test/session-native.test.ts", "opencode/packages/core/test/session-native-compaction.test.ts", "opencode/packages/server/script/qq-continuation-smoke.ts",
        "opencode/packages/session-ui/src/actions.ts", "opencode/packages/session-ui/src/message/message-content.tsx",
        "opencode/packages/app/src/session/composer/region.tsx", "opencode/packages/app/src/session/composer/timeline-actions.ts",
        "opencode/packages/server/script/qq-backend-continuation-smoke.ts", "opencode/packages/plugin/src/effect/conversation.ts",
        "modules/codex-native/src/backend.ts", "modules/codex-native/src/session-adapter.ts", "modules/codex-native/test/input.test.ts",
        "opencode/packages/server/script/qq-native-followup-smoke.ts",
        "opencode/packages/server/script/qq-wire-smoke.ts",
        "opencode/packages/plugin/src/promise/application.ts", "opencode/packages/plugin/src/promise/index.ts",
        "opencode/packages/server/src/application-modules.ts", "opencode/packages/server/src/fetch.ts", "opencode/packages/server/src/process.ts", "opencode/packages/server/src/routes.ts",
        "opencode/packages/server/test/application-modules.test.ts", "opencode/packages/server/test/process.test.ts", "opencode/packages/server/test/fetch.test.ts",
        "opencode/packages/im-assistant/src/portals.ts", "opencode/packages/im-assistant/src/cli.ts", "opencode/packages/im-assistant/package.json",
        "opencode/packages/cli/src/server-process.ts", "opencode/packages/server/package.json", "opencode/bun.lock",
        "opencode/packages/server/script/qq-product-smoke.ts",
    ]
    return {"schema_version": 1, "task": "R3-02", "status": "partial_verified", "publication": "disabled",
            "steps": steps, "http_acceptance": http, "transport_acceptance": wire, "product_acceptance": product, "backend_acceptance": native, "continuation_acceptance": continuation, "guidance_acceptance": guidance, "native_followup_acceptance": linked,
            "execution_owner": {"session": "original-opencode-session-inbox", "backend": "whole-native-conversation-backend"}, "production_credentials_used": False,
            "source_routing": {"owner": "original-plugin-kv", "frozen_envelope": True,
                               "reverse_lookup_requires_native_admission": True, "legacy_missing_source_is_not_inferred": True,
                               "outbound_transport_connected": False},
            "sources": {p.relative_to(ROOT).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                        for p in sorted([*module.glob("src/*.ts"), *(module / "test").rglob("*.ts"), module / "package.json", module / "tsconfig.json", *(ROOT / name for name in names)])},
            "remaining": ["authenticated transport and application-scoped product startup verified only against loopback OneBot fixtures; live QQ, persistent notifications, runtime module UI/status and durable recovery are not connected",
                          "opt-in controls include numbered selections from explicitly quoted published views; implicit latest-list selection, native stop fences, remote confirmation UI and remaining commands are not connected",
                          "ordinary Session and native backend current/closed input routing and cross-conversation confirmation are supported; whole-backend pending append remains blocked without native atomic append support",
                          "outbound first/final replies, result-unknown notification reconciliation and receipt recall remain unimplemented",
                          "attachments and companion routing are not consumed; unsupported input is refused without partial forwarding",
                          "formal R3-02 acceptance is not implemented and A23-A26 are not completed"]}


if __name__ == "__main__":
    print(json.dumps(run(), indent=2))
