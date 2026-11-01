"""Current-source release gate; historical R0-R4 proofs keep their original source anchors."""

import hashlib
import json
import re
import shutil
import subprocess
import tempfile
import time

from tools.assistant_policy_smoke import policy_smoke
from tools.assistant_theme_smoke import performance
from tools.capability_smoke import browser, sources as capability_sources, structured
from tools.native_baseline import ROOT, environment, provenance, run_command
from tools.native_conversation_smoke import conversation_smoke
from tools.qq_portal_smoke import _run as qq_regression
from tools.release_native_smoke import crash_smoke, migration_smoke
from tools.release_performance import REFERENCE, native_samples
from tools.verify_upstream import verify


def sources():
    values = capability_sources()
    for name in ("tools/release_smoke.py", "tools/release_native_smoke.py", "tools/release_performance.py",
                 "tests/rebase/test_r5_01.py", "docs/handoff/迁移与回退验收.md",
                 "upstream/theme-baseline.json"):
        values[name] = hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
    return dict(sorted(values.items()))


def unit(directory, args, label):
    receipt = run_command(directory, args, label)
    assert receipt["native_tests_passed"] and receipt["native_tests_failed"] == 0 and receipt["native_tests_skipped"] == 0
    print(json.dumps({"passed": label, "native_tests": receipt["native_tests_passed"]}), flush=True)
    return receipt


def codex_tests():
    executable = shutil.which("codex")
    assert executable, "Native CLI acceptance cannot be skipped"
    parent = ROOT / "runtime/codex-native"
    parent.mkdir(parents=True, exist_ok=True)
    # Keep locked-down native profiles locally: deleting a running shared service's files is unsafe.
    root = tempfile.mkdtemp(prefix="r5-release-", dir=parent)
    env = environment("r5-codex")
    env.update(IM_CODEX_EXECUTABLE=executable, IM_CODEX_TEST_ROOT=root)
    bun = str(ROOT / provenance()["runtime"]["bun"])
    steps = []
    commands = [("r5-codex-types", [str(ROOT / "opencode/node_modules/typescript/bin/tsc6"), "--project", "tsconfig.json"]),
                ("r5-codex-native", ["test", "--timeout", "60000"])]
    commands.extend(("r5-codex-race-" + str(index), ["test", "--timeout", "60000", "--test-name-pattern",
        "independent processes|racing restart"]) for index in range(1, 4))
    for label, args in commands:
        log = ROOT / ".reports/native" / (label + ".log")
        start = time.monotonic()
        with log.open("wb") as output:
            result = subprocess.run([bun, *args], cwd=ROOT / "modules/codex-native", env=env,
                stdout=output, stderr=subprocess.STDOUT, timeout=240,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        content = log.read_text(encoding="utf-8", errors="replace")
        count = re.search(r"\b(\d+) pass\s+.*?\b(\d+) fail", content, re.S)
        receipt = {"args": ["bun", *args], "cwd": "modules/codex-native", "exit_code": result.returncode,
            "duration_seconds": round(time.monotonic() - start, 2), "log": log.relative_to(ROOT).as_posix(),
            "passed": int(count[1]) if count else None, "failed": int(count[2]) if count else None,
            "skipped": sum(map(int, re.findall(r"\b(\d+) (?:skip|skipped)\b", content)))}
        log.with_suffix(".json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
        assert result.returncode == 0, "Native Codex gate failed: " + receipt["log"]
        steps.append(receipt)
    assert steps[1]["passed"] == 30 and steps[1]["failed"] == 0 and steps[1]["skipped"] == 0
    assert all(step["passed"] == 2 and step["failed"] == 0 and step["skipped"] == 0 for step in steps[2:])
    chains = []
    for name, expected in [("codex-backend-smoke", 12), ("codex-product-smoke", 7)]:
        receipt = run_command("packages/server", ["run", "script/" + name + ".ts"], "r5-" + name,
            extra_env={"IM_CODEX_EXECUTABLE": executable, "IM_CODEX_TEST_ROOT": root})
        chain = structured(receipt, "checks")
        assert chain["status"] == "passed" and len(chain["checks"]) == expected
        assert not chain["production_credentials_used"]
        steps.append(receipt)
        chains.append(chain)
    return {"steps": steps, "native_tests": 30, "race_stability_tests": 6, "http_checks": 19, "chains": chains}


def run():
    target = ROOT / "tests/rebase/release-evidence.json"
    target.write_text(json.dumps({"task": "R5-01", "status": "running", "publication": "disabled"}) + "\n", encoding="utf-8")
    try:
        result = _run()
    except Exception as error:
        target.write_text(json.dumps({"task": "R5-01", "status": "failed", "publication": "disabled",
            "error_type": type(error).__name__, "detail": str(error), "production_switched": False}, indent=2) + "\n", encoding="utf-8")
        raise
    target.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8", newline="\n")
    return result


def _run():
    assert verify()["verified"]
    before = sources()
    # Fail fast on changed keepers before the longer native account/transport rehearsals.
    steps = browser_regressions()
    print("R5: serial performance and native baseline", flush=True)
    # Performance is serial and finishes before correctness suites create competing processes.
    native_performance = native_samples()
    receipt = run_command("packages/app", ["x", "--no-install", "playwright", "test", "--config",
        "e2e/performance/playwright.config.ts", "timeline/session-tab-switch-benchmark.spec.ts", "--grep",
        "assistant conversation profile", "--repeat-each", "3", "--workers", "1", "--retries", "0", "--reporter", "json"],
        "r5-production-rendering", extra_env={"PLAYWRIGHT_PORT": "4351", "VITE_OPENCODE_TEST_FIXTURES": "1",
            "PLAYWRIGHT_HTML_OPEN": "never", "OPENCODE_PERFORMANCE_RUN_ID": "r5-release"})
    browser(receipt, 3)
    rendering = performance(structured(receipt, "stats"))
    steps.append(receipt)
    baseline = json.loads((ROOT / "upstream/theme-baseline.json").read_text(encoding="utf-8"))
    assert before["opencode/packages/app/e2e/performance/timeline/session-tab-switch-benchmark.spec.ts"] == baseline["benchmark_definition_sha256"]

    core = ["session-prompt", "session-store", "session-run-coordinator", "session-compact", "session-native-compaction",
        "session-view", "session-execution", "session-runner-retry", "runtime-policy", "session-owned", "tool-registry",
        "conversation-backend", "session-inbox-append", "session-input"]
    steps.append(unit("packages/core", ["run", "test", *["test/" + name + ".test.ts" for name in core]], "r5-native-core"))
    steps.append(unit("packages/client", ["test", "test/solid-data.test.ts", "test/solid-inbox-race.test.ts",
        "test/solid-pending-status.test.ts", "test/solid-refresh.test.ts"], "r5-native-client"))
    steps.append(unit("packages/desktop", ["test", "--timeout", "30000", "src/main/storage"], "r5-native-storage"))
    steps.append(unit("packages/app", ["test", "--conditions=solid", "--preload", "../ui/test/solid-jsx.ts", "--preload",
        "./happydom.ts", "src/session/composer/queue.test.ts", "src/session/list.test.ts", "src/workspaces/inventory.test.ts"], "r5-native-ui-state"))
    steps.append(unit("packages/app", ["test", "--conditions=browser", "--preload", "../ui/test/solid-jsx.ts", "--preload",
        "./happydom.ts", *["./test-browser/" + name + ".test.ts" for name in
            ("prompt-submission-state", "session-resolution", "timeline-cache", "timeline-projection")]], "r5-native-history-state"))
    policy = policy_smoke()
    conversation = conversation_smoke()
    crash = crash_smoke()
    migration = migration_smoke()
    print("R5: policy, native conversation, crash and migration passed; starting Codex", flush=True)
    codex = codex_tests()
    print("R5: Codex passed; starting current-source QQ compatibility", flush=True)
    qq = qq_regression()
    assert all(value["status"] == "passed" and not value["actual_qq_connection"] and not value["external_messages_sent"]
        for key, value in qq.items() if key.endswith("_acceptance"))
    print("R5: QQ passed; checking types, workspace and compiled desktop", flush=True)
    steps.append(run_command("packages/app", ["run", "typecheck:e2e"], "r5-release-e2e-types"))
    steps.append(run_command(".", ["run", "check"], "r5-workspace"))
    assert "36 successful, 36 total" in (ROOT / steps[-1]["log"]).read_text(encoding="utf-8")
    steps.append(run_command(".", ["run", "lint:changed", REFERENCE], "r5-release-gui-lint", extra_env={
        "GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "diff.relative", "GIT_CONFIG_VALUE_0": "true"}))
    match = re.search(r"0 problem\(s\) in 0 of (\d+) changed files", (ROOT / steps[-1]["log"]).read_text(encoding="utf-8"))
    assert match and int(match[1]) >= 8
    steps.append(run_command("packages/desktop", ["x", "--no-install", "electron-vite", "build"], "r5-desktop-build"))
    assert before == sources(), "Release sources changed during acceptance"
    return {"task": "R5-01", "status": "verified", "publication": "disabled", "production_switched": False,
        "sources": before, "steps": steps, "workspace_checks": 36, "standalone_e2e_diagnostics": 0,
        "gui_linted_files": int(match[1]), "native_performance": native_performance,
        "rendering": {"original_reference": baseline["performance"], "reference_source": baseline["source_base_revision"],
            "current": rendering, "same_fixture": True}, "policy": policy, "conversation": conversation,
        "crash": crash, "migration": migration, "codex": codex,
        "qq": {key: value for key, value in qq.items() if key != "sources"},
        "production_credentials_used": False, "external_messages_sent": 0,
        "limits": ["isolated loopback and native profiles, not a live QQ/account rollout",
            "unknown remote sends remain unresolved and are never blindly resent; automatic reconciliation/reconnect is not claimed",
            "native restart is at-least-once for unfinished model inference; arbitrary external side effects are not claimed exactly-once",
            "production switch, real old-client data conversion, installer and other OS/users remain separate release actions",
            "business modules and the separate companion chatbot remain later work"]}


def browser_regressions():
    steps = []
    for args, label, expected in [
        (["e2e/regression/composer.spec.ts", "e2e/regression/review.spec.ts", "e2e/regression/session-panel-scrollbar.spec.ts",
          "e2e/regression/settings.spec.ts", "e2e/regression/timeline-geometry.spec.ts", "e2e/regression/timeline-stream.spec.ts",
          "--grep", "free usage limit|Go usage limit|context hides free|suppresses the scrollbar|background activity alignment|scrolls the timeline behind|compaction|shows a running subagent",
          "--repeat-each", "10"], "r5-typed-keeper-browser", 140),
        (["e2e/regression/session-queue.spec.ts", "e2e/regression/timeline-history.spec.ts", "--grep-invert", "assistant motion"],
            "r5-native-interaction-browser", 57),
        (["e2e/regression/tabs.spec.ts", "e2e/regression/settings.spec.ts", "e2e/regression/timeline-history.spec.ts",
          "--grep", "assistant layout|assistant appearance|assistant motion|capabilities:|backends:"],
            "r5-integrated-browser", 17),
    ]:
        receipt = run_command("packages/app", ["run", "test:e2e:built", "--", *args, "--project", "chromium",
            "--workers", "5", "--retries", "0", "--reporter", "json"], label, extra_env={"PLAYWRIGHT_PORT": "4350",
            "VITE_OPENCODE_TEST_FIXTURES": "1", "PLAYWRIGHT_HTML_OPEN": "never"})
        browser(receipt, expected)
        steps.append(receipt)
        print(json.dumps({"passed": label, "browser_tests": expected}), flush=True)
    return steps
