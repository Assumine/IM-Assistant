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
    for label, args in [
        ("r3-qq-module-types", [bun, str(ROOT / "opencode/node_modules/typescript/bin/tsc6"), "--project", "tsconfig.json"]),
        ("r3-qq-module-tests", [bun, "test"]),
    ]:
        log = reports / (label + ".log")
        with log.open("wb") as output:
            process = subprocess.run(args, cwd=module, env=environment("qq-ingress"), stdout=output, stderr=subprocess.STDOUT,
                                     timeout=120, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        content = log.read_text(encoding="utf-8", errors="replace")
        counts = re.search(r"\b(\d+) pass\s+.*?\b(\d+) fail", content, re.S)
        skipped = sum(map(int, re.findall(r"\b(\d+) (?:skip|skipped)\b", content)))
        if process.returncode or skipped or label.endswith("tests") and (not counts or (int(counts[1]), int(counts[2])) != (59, 0)):
            raise RuntimeError(f"QQ module check failed: {label}; see {log.relative_to(ROOT)}")
        steps.append({"label": label, "exit_code": process.returncode, "passed": int(counts[1]) if counts else None, "skipped": skipped, "log": log.relative_to(ROOT).as_posix()})
    steps.append(run_command("packages/server", ["run", "script/qq-portal-smoke.ts"], "r3-qq-http", timeout=180,
                             extra_env={"IM_QQ_TEST_ROOT": directory}))
    lines = (reports / "r3-qq-http.log").read_text(encoding="utf-8").splitlines()
    http = json.loads(next(line for line in reversed(lines) if line.startswith('{"status":')))
    if http["status"] != "passed" or len(http["checks"]) != 15 or http["model_requests"] != 5 or http["actual_qq_connection"] or http["external_messages_sent"]:
        raise RuntimeError("QQ original SDK/HTTP/SQLite acceptance was incomplete")
    native_parent = ROOT / "runtime/codex-native"
    native_parent.mkdir(parents=True, exist_ok=True)
    native_directory = tempfile.mkdtemp(prefix="qq-backend-", dir=native_parent)
    steps.append(run_command("packages/server", ["run", "script/qq-backend-smoke.ts"], "r3-qq-native-http", timeout=180,
                             extra_env={"IM_CODEX_EXECUTABLE": executable, "IM_QQ_BACKEND_TEST_ROOT": native_directory}))
    lines = (reports / "r3-qq-native-http.log").read_text(encoding="utf-8").splitlines()
    native = json.loads(next(line for line in reversed(lines) if line.startswith('{"status":')))
    if native["status"] != "passed" or len(native["checks"]) != 10 or native["model_requests"] != 4 or native["native_admissions"] != 5 or native["actual_qq_connection"] or native["external_messages_sent"] or native["production_credentials_used"]:
        raise RuntimeError("QQ real native backend target acceptance was incomplete")
    for package, files, label, count, filters in [
        ("sdk", ["test/instances.test.ts", "test/instances-effect.test.ts"], "r3-qq-sdk-regression", 8, []),
        ("core", ["test/session-inbox-append.test.ts", "test/session-owned.test.ts", "test/session-prompt.test.ts"], "r3-qq-append-session-regression", 77, []),
        ("client", ["test/solid-inbox-race.test.ts"], "r3-qq-append-client-unit", 7, []),
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
    ]
    return {"schema_version": 1, "task": "R3-02", "status": "partial_verified", "publication": "disabled",
            "steps": steps, "http_acceptance": http, "backend_acceptance": native,
            "execution_owner": {"session": "original-opencode-session-inbox", "backend": "whole-native-conversation-backend"}, "production_credentials_used": False,
            "source_routing": {"owner": "original-plugin-kv", "frozen_envelope": True,
                               "reverse_lookup_requires_native_admission": True, "legacy_missing_source_is_not_inferred": True,
                               "outbound_transport_connected": False},
            "sources": {p.relative_to(ROOT).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                        for p in sorted([*module.glob("src/*.ts"), *module.glob("test/*.ts"), module / "package.json", module / "tsconfig.json", *(ROOT / name for name in names)])},
            "remaining": ["live authenticated OneBot transport and product activation are not connected",
                          "controls are classified only; remote control dispatch and authorization are not implemented",
                          "only pending ordinary Session quotes can append; active or completed quotes, whole-backend adjustments and cross-conversation confirmation remain blocked until their native guarded contracts exist",
                          "outbound first/final replies, result-unknown notification reconciliation and receipt recall remain unimplemented",
                          "attachments and companion routing are not consumed; unsupported input is refused without partial forwarding",
                          "formal R3-02 acceptance is not implemented and A23-A26 are not completed"]}


if __name__ == "__main__":
    print(json.dumps(run(), indent=2))
