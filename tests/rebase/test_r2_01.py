"""Exercise original conversation owners; do not implement another queue in the harness."""
import json
import unittest

from tools.native_baseline import ROOT, run_command
from tools.native_conversation_smoke import conversation_smoke
from tools.verify_upstream import verify


class NativeConversationTests(unittest.TestCase):
    def test_01_original_source_and_patch_ledger(self):
        self.assertTrue(verify()["verified"])

    def test_02_native_state_owners(self):
        cases = [
            ("packages/client", ["run", "test", "test/solid-data.test.ts", "test/solid-inbox-race.test.ts"],
                "r2-01-client-unit", 41),
            ("packages/app", ["test", "--conditions=solid", "--preload", "../ui/test/solid-jsx.ts",
                "--preload", "./happydom.ts", "./src/session/composer/queue.test.ts", "./src/session/list.test.ts"],
                "r2-01-native-unit", 19),
            ("packages/app", ["test", "--conditions=browser", "--preload", "../ui/test/solid-jsx.ts",
                "--preload", "./happydom.ts", "./test-browser/prompt-submission-state.test.ts",
                "./test-browser/session-resolution.test.ts", "./test-browser/timeline-cache.test.ts",
                "./test-browser/timeline-projection.test.ts"], "r2-01-browser-state-unit", 35),
        ]
        for cwd, command, label, count in cases:
            with self.subTest(owner=label):
                # Bun can silently ignore a missing filter if another filter finds tests.
                for argument in command:
                    if argument.endswith(".test.ts"):
                        self.assertTrue((ROOT / "opencode" / cwd / argument).is_file(), argument)
                result = run_command(cwd, command, label)
                self.assertEqual((result["native_tests_passed"], result["native_tests_failed"],
                    result["native_tests_skipped"]), (count, 0, 0))

    def test_03_real_http_drain_with_model_held_before_first_token(self):
        result = conversation_smoke()
        self.assertEqual(result["model_requests"], 4)
        self.assertEqual(result["external_model_requests"], 0)
        self.assertTrue(result["final_step_then_next_delivery_then_drain_idle"])
        self.assertTrue(result["restart_preserves_order_without_reexecution"])
        (ROOT / ".reports/native/conversation-smoke.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")

    def test_04_production_browser_queue_and_history_keepers(self):
        result = run_command("packages/app", ["run", "test:e2e:built", "--",
            "e2e/regression/session-queue.spec.ts", "e2e/regression/timeline-history.spec.ts",
            "--project", "chromium", "--workers=2", "--retries=0"], "r2-01-native-browser",
            extra_env={"PLAYWRIGHT_PORT": "4382"})
        self.assertEqual((result["native_tests_passed"], result["native_tests_failed"], result["native_tests_skipped"]), (47, 0, 0))

    def test_05_new_cases_are_independent_at_ci_concurrency(self):
        result = run_command("packages/app", ["run", "test:e2e:built", "--",
            "e2e/regression/session-queue.spec.ts", "--grep", "conversation host",
            "--project", "chromium", "--workers=5", "--repeat-each=10", "--retries=0"],
            "r2-01-conversation-repeat", extra_env={"PLAYWRIGHT_PORT": "4382", "PLAYWRIGHT_FULLY_PARALLEL": "1"})
        self.assertEqual((result["native_tests_passed"], result["native_tests_failed"], result["native_tests_skipped"]), (20, 0, 0))

    def test_06_canonical_native_checks(self):
        self.assertEqual(run_command(".", ["run", "check"], "r2-01-full-check")["exit_code"], 0)

    def test_07_live_words_animate_once_and_completed_content_does_not_replay(self):
        result = run_command("packages/session-ui", ["x", "playwright", "test", "--config",
            "playwright.components.config.ts", "component-tests/markdown.spec.ts", "--grep",
            "keeps live elements and selection", "--workers=2", "--repeat-each=10", "--retries=0"],
            "r2-01-markdown-motion", extra_env={"PLAYWRIGHT_STORIES_PORT": "4383", "CI": "1"})
        self.assertEqual((result["native_tests_passed"], result["native_tests_failed"], result["native_tests_skipped"]), (10, 0, 0))


if __name__ == "__main__":
    unittest.main()
