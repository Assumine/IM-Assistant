"""Verify public application capabilities on the pinned native app, never on a live account."""

import hashlib
import json
from pathlib import Path
import re
import shutil
import tempfile

from tools.native_baseline import ROOT, run_command
from tools.qq_portal_smoke import _run as qq_regression
from tools.verify_upstream import verify


def sources():
    ledger = json.loads((ROOT / "upstream/patches.json").read_text(encoding="utf-8"))
    files = {"opencode/" + item["path"] for patch in ledger["patches"] for item in patch["files"]}
    for module in (ROOT / "modules").iterdir():
        if not (module / "package.json").is_file():
            continue
        for directory in (module / "src", module / "test"):
            files.update(path.relative_to(ROOT).as_posix() for path in directory.rglob("*.ts"))
    files.update(["tools/capability_smoke.py", "tools/qq_portal_smoke.py", "tools/native_baseline.py",
                  "tests/rebase/test_r4_01.py"])
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in sorted(files)}


def structured(receipt, key):
    """Build output can precede the original Playwright JSON reporter."""
    content = (ROOT / receipt["log"]).read_text(encoding="utf-8", errors="replace")
    decoder = json.JSONDecoder()
    for match in re.finditer(r"(?m)^\{", content):
        try:
            value, _ = decoder.raw_decode(content, match.start())
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and key in value:
            return value
    raise RuntimeError("Missing native structured report: " + receipt["log"])


def browser(receipt, expected):
    report = structured(receipt, "stats")
    stats = report["stats"]
    if (stats["expected"] != expected or stats["unexpected"] or stats["flaky"] or stats["skipped"]
            or report.get("errors")):
        raise RuntimeError("Required browser cases failed, retried, skipped or did not execute")
    receipt.update(native_tests_passed=expected, native_tests_failed=0, native_tests_skipped=0)
    return stats


def unit(receipt, expected):
    if (receipt["native_tests_passed"] != expected or receipt["native_tests_failed"]
            or receipt["native_tests_skipped"]):
        raise RuntimeError("Required native capability cases did not all execute")


def run():
    checkpoint = ROOT / "upstream/capability-checkpoint.json"
    checkpoint.write_text(json.dumps({"task": "R4-01", "status": "running", "publication": "disabled"}) + "\n",
                          encoding="utf-8", newline="\n")
    try:
        result = _run()
        checkpoint.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8", newline="\n")
        return result
    except Exception:
        checkpoint.write_text(json.dumps({"task": "R4-01", "status": "failed", "publication": "disabled"}) + "\n",
                              encoding="utf-8", newline="\n")
        raise


def _run():
    upstream = verify()
    before = sources()
    steps = []

    steps.append(run_command(".", ["run", "check"], "r4-capabilities-workspace", timeout=600))
    content = (ROOT / steps[-1]["log"]).read_text(encoding="utf-8", errors="replace")
    if not re.search(r"36 successful, 36 total", content):
        raise RuntimeError("The canonical workspace check did not cover all 36 workspaces")

    steps.append(run_command("packages/server", ["test", "test/capabilities.test.ts"],
                             "r4-capabilities-server", timeout=180))
    unit(steps[-1], 5)

    parent = ROOT / "runtime/baseline"
    parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="capability-acceptance-", dir=parent) as directory:
        steps.append(run_command("packages/server", ["run", "script/capabilities-smoke.ts"],
                                 "r4-capabilities-native", timeout=180,
                                 extra_env={"IM_CAPABILITY_TEST_ROOT": directory}))
    chain = structured(steps[-1], "native_state_owner")
    if (chain["status"] != "passed" or len(chain["checks"]) != 5 or chain["model_requests"] != 2
            or chain["metric_samples"] != 1 or chain["actual_qq_connection"]
            or chain["external_messages_sent"] or chain["production_credentials_used"]):
        raise RuntimeError("Native capability/Inbox/Runner/SQLite chain acceptance was incomplete")

    # Execute the current QQ product and original native regressions. Do not
    # overwrite the historical R3-02 checkpoint or retie it to newer sources.
    qq = qq_regression()
    qq_tests = sum(step.get("native_tests_passed", step.get("passed")) or 0 for step in qq["steps"])
    qq_checks = sum(len(value["checks"]) for key, value in qq.items() if key.endswith("_acceptance"))
    if (qq_tests != 699 or qq_checks != 147 or qq["production_credentials_used"]
            or qq["product_acceptance"].get("capability_status") != "native-application-owner"):
        raise RuntimeError("Current native QQ product compatibility was incomplete")
    for key, value in qq.items():
        if not key.endswith("_acceptance"):
            continue
        if value["status"] != "passed" or value["actual_qq_connection"] or value["external_messages_sent"]:
            raise RuntimeError("QQ compatibility must remain isolated and fully executed")
    steps.extend(qq["steps"])

    browser_args = ["run", "test:e2e:built", "--", "e2e/regression/settings.spec.ts", "--grep", "capabilities:",
                    "--project", "chromium", "--workers", "1", "--retries", "0", "--reporter", "json"]
    browser_env = {"PLAYWRIGHT_PORT": "4341", "VITE_OPENCODE_TEST_FIXTURES": "1", "PLAYWRIGHT_HTML_OPEN": "never"}
    steps.append(run_command("packages/app", browser_args, "r4-capabilities-browser", timeout=600,
                             extra_env=browser_env))
    browser(steps[-1], 3)
    # Keep the actual rendered artifacts before Playwright cleans the results
    # directory for repeat runs. These files stay local and out of Git.
    previews = ROOT / ".reports/native/r4-capabilities-previews"
    previews.mkdir(exist_ok=True)
    for path in (ROOT / "opencode/packages/app/e2e/test-results").rglob("*.png"):
        shutil.copyfile(path, previews / path.name)

    steps.append(run_command("packages/app", ["x", "--no-install", "playwright", "test", "--config",
                             "playwright.components.config.ts", "plugin-", "--workers", "1", "--retries", "0",
                             "--reporter", "json"], "r4-capabilities-components", timeout=600,
                             extra_env={"PLAYWRIGHT_STORIES_PORT": "3294", "PLAYWRIGHT_HTML_OPEN": "never"}))
    component_stats = browser(steps[-1], 31)

    steps.append(run_command(".", ["run", "lint:changed", "HEAD"], "r4-capabilities-gui-lint", timeout=180,
                             extra_env={"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "diff.relative",
                                        "GIT_CONFIG_VALUE_0": "true"}))
    lint = (ROOT / steps[-1]["log"]).read_text(encoding="utf-8", errors="replace")
    count = re.search(r"0 problem\(s\) in 0 of (\d+) changed files", lint)
    if not count or int(count[1]) < 11:
        raise RuntimeError("Changed-file GUI lint did not cover the actual native GUI changes")

    # Race/cleanup stability is reported separately, not inflated into unique
    # primary case counts. The original unit and E2E harnesses own each run.
    repeats = []
    repeats.append(run_command("packages/server", ["test", "--rerun-each", "10", "test/capabilities.test.ts"],
                               "r4-capabilities-server-stability", timeout=240))
    unit(repeats[-1], 50)
    repeat_args = browser_args.copy()
    repeat_args[repeat_args.index("--workers") + 1] = "5"
    repeat_args += ["--repeat-each", "10"]
    repeats.append(run_command("packages/app", repeat_args, "r4-capabilities-browser-stability", timeout=600,
                               extra_env=browser_env))
    browser(repeats[-1], 30)

    if before != sources():
        raise RuntimeError("Source changed while the native acceptance was running")
    return {"schema_version": 1, "task": "R4-01", "status": "partial_verified", "publication": "disabled",
            "scope": "isolated-current-source-native-application-not-live-account-rollout", "upstream": upstream,
            "steps": steps, "sources": before, "native_unit_tests": 704, "native_chain_checks": 152,
            "browser_tests": 3 + component_stats["expected"], "workspace_checks": 36,
            "stability": {"native_tests": 50, "browser_tests": 30, "steps": repeats},
            "native_acceptance": chain,
            "qq_compatibility": {"native_tests": qq_tests, "chain_checks": qq_checks,
                                 "product": qq["product_acceptance"], "source_count": len(qq["sources"])},
            "ownership": {"application": "original-native-application-scope",
                          "conversation": "original-opencode-session-inbox-or-whole-native-backend",
                          "notifications": "original-native-kv-notice-read-resolution-facts",
                          "monitoring": "visible-module-panel-only-no-global-hardware-poll"},
            "production_credentials_used": False, "actual_qq_connection": False, "external_messages_sent": 0,
            "remaining": ["real accounts, other OS and packaged desktop remain unverified",
                          "optional module stop applies only to this service run; configuration enablement remains next-start",
                          "hardware/process metric providers and the independent QQ chatbot are not migrated",
                          "global navigation theme, marketplace and actual business-module UI are later work"]}


if __name__ == "__main__":
    print(json.dumps(run(), indent=2))
