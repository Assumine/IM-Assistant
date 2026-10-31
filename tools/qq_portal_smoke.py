"""Isolated QQ ingress slice verification. Never connects to QQ or sends an external message."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile

from tools.native_baseline import ROOT, environment, provenance, run_command


def run():
    checkpoint = ROOT / "upstream/qq-checkpoint.json"
    checkpoint.write_text(json.dumps({"task": "R3-02", "status": "running", "publication": "disabled"}) + "\n", encoding="utf-8")
    try:
        result = _run()
        checkpoint.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        return result
    except Exception:
        checkpoint.write_text(json.dumps({"task": "R3-02", "status": "failed", "publication": "disabled"}) + "\n", encoding="utf-8")
        raise


def _run():
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
        if process.returncode or skipped or label.endswith("tests") and (not counts or (int(counts[1]), int(counts[2])) != (32, 0)):
            raise RuntimeError(f"QQ module check failed: {label}; see {log.relative_to(ROOT)}")
        steps.append({"label": label, "exit_code": process.returncode, "passed": int(counts[1]) if counts else None, "skipped": skipped, "log": log.relative_to(ROOT).as_posix()})
    steps.append(run_command("packages/server", ["run", "script/qq-portal-smoke.ts"], "r3-qq-http", timeout=180,
                             extra_env={"IM_QQ_TEST_ROOT": directory}))
    lines = (reports / "r3-qq-http.log").read_text(encoding="utf-8").splitlines()
    http = json.loads(next(line for line in reversed(lines) if line.startswith('{"status":')))
    if http["status"] != "passed" or len(http["checks"]) != 10 or http["model_requests"] != 5 or http["actual_qq_connection"] or http["external_messages_sent"]:
        raise RuntimeError("QQ original SDK/HTTP/SQLite acceptance was incomplete")
    for package, files, label, count, filters in [
        ("sdk", ["test/instances.test.ts", "test/instances-effect.test.ts"], "r3-qq-sdk-regression", 8, []),
    ]:
        if not all((ROOT / "opencode/packages" / package / name).is_file() for name in files):
            raise RuntimeError("Required original SDK regression file is absent")
        # Markerless VCS fixtures must be outside this Git checkout, just like the original R1 project regression.
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
    ]
    return {"schema_version": 1, "task": "R3-02", "status": "partial_verified", "publication": "disabled",
            "steps": steps, "http_acceptance": http, "execution_owner": "original-opencode-session-inbox", "production_credentials_used": False,
            "sources": {p.relative_to(ROOT).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                        for p in sorted([*module.glob("src/*.ts"), *module.glob("test/*.ts"), module / "package.json", module / "tsconfig.json", *(ROOT / name for name in names)])},
            "remaining": ["live authenticated OneBot transport and product activation are not connected",
                          "controls are classified only; remote control dispatch and authorization are not implemented",
                          "known quoted adjustments and cross-conversation confirmation remain blocked until native conditional admission/update contracts exist",
                          "Codex whole-backend targets, outbound first/final replies, result-unknown notification reconciliation and receipt recall remain unimplemented",
                          "attachments and companion routing are not consumed; unsupported input is refused without partial forwarding",
                          "formal R3-02 acceptance is not implemented and A23-A26 are not completed"]}


if __name__ == "__main__":
    print(json.dumps(run(), indent=2))
