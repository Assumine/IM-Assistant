"""Native presentation acceptance; never a second application or conversation controller."""

from collections import Counter
import hashlib
import json
import re
import statistics

from tools.assistant_theme_desktop import run as desktop
from tools.capability_smoke import browser, sources as capability_sources, structured
from tools.native_baseline import ROOT, run_command
from tools.native_conversation_smoke import conversation_smoke
from tools.verify_upstream import verify


def cases(report):
    for suite in report.get("suites", []):
        yield from cases(suite)
    for spec in report.get("specs", []):
        for test in spec["tests"]:
            yield spec, test


def identities(report):
    return sorted(spec["file"].replace("\\", "/") + ":" + spec["title"] for spec, _ in cases(report))


def performance(report):
    values = []
    for _, test in cases(report):
        for result in test["results"]:
            assert result["retry"] == 0 and result["status"] == "passed"
            for output in result["stdout"]:
                for line in output.get("text", "").splitlines():
                    if not line.startswith("BENCHMARK "):
                        continue
                    value = json.loads(line.removeprefix("BENCHMARK "))
                    assert value["context"]["profile"] == "conversation"
                    assert value["context"]["messagesPerSession"] == 40
                    values.append(value["metrics"]["summary"]["all"])
    assert len(values) == 3, "The same three production benchmark runs must execute"
    return {"samples": values, "median": {
        key: statistics.median(value[key] for value in values)
        for key in ("firstObservedMs", "stableObservedMs")}}


def diagnostics(content):
    return sorted(" | ".join(match) for match in re.findall(
        r"(?m)^(e2e/[^\n]+?)\(\d+,\d+\): error (TS\d+): ([^\n]+)", content))


def sources():
    values = capability_sources()
    for name in ("tools/assistant_theme_smoke.py", "tools/assistant_theme_desktop.py",
                 "tools/assistant_theme_desktop.mjs", "tools/assistant_theme_window.py",
                 "tests/rebase/test_r4_02.py", "upstream/theme-baseline.json"):
        values[name] = hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
    return dict(sorted(values.items()))


def run():
    checkpoint = ROOT / "upstream/theme-checkpoint.json"
    checkpoint.write_text(json.dumps({"task": "R4-02", "status": "running", "publication": "disabled"}) + "\n",
                          encoding="utf-8", newline="\n")
    try:
        result = _run()
    except Exception:
        checkpoint.write_text(json.dumps({"task": "R4-02", "status": "failed", "publication": "disabled"}) + "\n",
                              encoding="utf-8", newline="\n")
        raise
    checkpoint.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8", newline="\n")
    return result


def _run():
    assert verify()["verified"]
    before = sources()
    baseline = json.loads((ROOT / "upstream/theme-baseline.json").read_text(encoding="utf-8"))
    benchmark = "opencode/packages/app/e2e/performance/timeline/session-tab-switch-benchmark.spec.ts"
    assert before[benchmark] == baseline["benchmark_definition_sha256"]
    steps = []

    # First run performance alone, before other checks can load the machine.
    steps.append(run_command("packages/app", ["x", "--no-install", "playwright", "test", "--config",
        "e2e/performance/playwright.config.ts", "timeline/session-tab-switch-benchmark.spec.ts", "--grep",
        "assistant conversation profile", "--repeat-each", "3", "--workers", "1", "--retries", "0",
        "--max-failures", "1", "--reporter", "json"], "r4-theme-profile-performance-after", timeout=600,
        extra_env={"PLAYWRIGHT_PORT": "4343", "VITE_OPENCODE_TEST_FIXTURES": "1",
                   "PLAYWRIGHT_HTML_OPEN": "never", "OPENCODE_PERFORMANCE_RUN_ID": "r4-theme-profile-after"}))
    browser(steps[-1], 3)
    measured = performance(structured(steps[-1], "stats"))
    comparison = {"before": baseline["performance"], "after": measured,
                  "median_change_ms": {key: round(measured["median"][key] - baseline["performance"]["median"][key], 2)
                     for key in measured["median"]},
                  "interpretation": "three isolated local samples; descriptive comparison, not a universal latency guarantee"}

    steps.append(run_command("packages/client", ["test", "test/solid-data.test.ts", "test/solid-inbox-race.test.ts",
        "test/solid-pending-status.test.ts", "test/solid-refresh.test.ts"], "r4-theme-native-client", timeout=180))
    assert steps[-1]["native_tests_passed"] == 62 and steps[-1]["native_tests_failed"] == 0
    steps.append(run_command("packages/app", ["test", "--conditions=solid", "--preload", "../ui/test/solid-jsx.ts",
        "--preload", "./happydom.ts", "./src/workspaces/inventory.test.ts"], "r4-theme-inventory", timeout=180))
    assert steps[-1]["native_tests_passed"] == 7 and steps[-1]["native_tests_failed"] == 0

    steps.append(run_command("packages/app", ["run", "test:e2e:built", "--",
        "e2e/regression/session-queue.spec.ts", "e2e/regression/timeline-history.spec.ts", "--grep-invert",
        "assistant motion", "--project", "chromium", "--workers", "2", "--retries", "0", "--reporter", "json"],
        "r4-theme-interaction-after", timeout=600, extra_env={"PLAYWRIGHT_PORT": "4342",
        "VITE_OPENCODE_TEST_FIXTURES": "1", "PLAYWRIGHT_HTML_OPEN": "never"}))
    browser(steps[-1], 57)
    assert identities(structured(steps[-1], "stats")) == baseline["interaction_cases"]

    steps.append(run_command("packages/app", ["run", "test:e2e:built", "--",
        "e2e/regression/tabs.spec.ts", "e2e/regression/timeline-history.spec.ts", "e2e/regression/settings.spec.ts",
        "--grep", "assistant layout|assistant motion|assistant appearance", "--repeat-each", "5", "--project",
        "chromium", "--workers", "3", "--retries", "0", "--reporter", "json"], "r4-theme-presentation", timeout=600,
        extra_env={"PLAYWRIGHT_PORT": "4342", "VITE_OPENCODE_TEST_FIXTURES": "1", "PLAYWRIGHT_HTML_OPEN": "never"}))
    browser(steps[-1], 15)

    steps.append(run_command("packages/desktop", ["x", "--no-install", "electron-vite", "build"],
                             "r4-theme-desktop-build", timeout=600))
    window = desktop()
    assert len(window["checks"]) == 4 and window["legacy_migration_requests"] == 0 and window["rejected_api_requests"] == 0
    native = conversation_smoke()
    assert native["real_native_http_and_sqlite"] and native["model_requests"] == 4

    steps.append(run_command(".", ["run", "check"], "r4-theme-workspace", timeout=600))
    assert re.search(r"36 successful, 36 total", (ROOT / steps[-1]["log"]).read_text(encoding="utf-8"))
    steps.append(run_command(".", ["run", "lint:changed", baseline["source_base_revision"]], "r4-theme-gui-lint", timeout=180,
        extra_env={"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "diff.relative", "GIT_CONFIG_VALUE_0": "true"}))
    lint = (ROOT / steps[-1]["log"]).read_text(encoding="utf-8")
    match = re.search(r"0 problem\(s\) in 0 of (\d+) changed files", lint)
    assert match and int(match[1]) > 0, "The strict changed-file lint must actually inspect GUI source"

    # Keep the known standalone E2E typing failure visible. A new diagnostic fails this task.
    try:
        typing = run_command("packages/app", ["run", "typecheck:e2e"], "r4-theme-e2e-types", timeout=180)
    except RuntimeError:
        typing = json.loads((ROOT / ".reports/native/r4-theme-e2e-types.json").read_text(encoding="utf-8"))
    observed = diagnostics((ROOT / typing["log"]).read_text(encoding="utf-8"))
    assert not (Counter(observed) - Counter(baseline["existing_e2e_diagnostics"])), "New standalone E2E type errors"
    assert len(observed) == 14, "Reconcile any change to the recorded typing limitation explicitly"

    assert before == sources(), "Product or acceptance sources changed during the real execution"
    return {"task": "R4-02", "status": "partial_verified", "publication": "disabled", "sources": before,
            "steps": steps, "workspace_checks": 36, "gui_linted_files": int(match[1]),
            "interaction_before": 57, "interaction_after": 57, "presentation_tests": 15,
            "browser_tests": 72, "native_unit_tests": 69, "benchmark_runs": 3, "performance": comparison,
            "desktop": window, "native_conversation": native,
            "standalone_e2e_typecheck": {"status": "failed-existing-diagnostics", "diagnostics": 14,
                                        "new_diagnostics": 0, "receipt": typing},
            "ownership": "original-native-session-inbox-history-settings-and-desktop",
            "production_credentials_used": False, "actual_qq_connection": False, "external_messages_sent": 0,
            "remaining": ["R5 fault and release acceptance, including the fourteen pre-existing standalone E2E type errors",
                          "packaged installer, other OS and other Windows users are not verified",
                          "real accounts, hardware providers, marketplace and business-module migration remain outside this task"]}
