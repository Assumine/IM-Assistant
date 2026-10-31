"""API configuration and usage acceptance drives the native owners, HTTP service and built UI."""
import json
import unittest

from tools.auxiliary_usage_smoke import smoke as auxiliary_smoke
from tools.native_baseline import ROOT, run_command
from tools.provider_configuration_smoke import smoke as configuration_smoke
from tools.provider_discovery_smoke import smoke as discovery_smoke
from tools.verify_upstream import verify


class NativeProviderUsageTests(unittest.TestCase):
    def test_01_original_source_and_declared_patch_hashes(self):
        self.assertTrue(verify()["verified"])

    def test_02_native_accounting_models_credentials_and_client_contracts(self):
        cases = [
            ("packages/core", ["run", "test", "test/session-stats.test.ts", "test/session-usage.test.ts",
                "test/session-title.test.ts", "test/session-compaction.test.ts", "test/session-native-compaction.test.ts",
                "test/session-compaction-transport.test.ts", "test/session-generate.test.ts", "test/bus.test.ts"], "usage-owners", 130),
            ("packages/core", ["run", "test", "test/config/provider.test.ts", "test/config/provider-options.test.ts",
                "test/config/entry-observer.test.ts", "test/credential.test.ts"], "account-owners", 51),
            ("packages/im-assistant", ["test", "src/providers.test.ts", "src/storage.test.ts"], "catalog-owners", 7),
            ("packages/client", ["run", "test", "test/promise.test.ts", "test/effect.test.ts",
                "test/deprecated-aliases.test.ts", "test/contract-identity.test.ts", "test/import-boundaries.test.ts"], "client-contracts", 56),
            ("packages/protocol", ["run", "test"], "protocol", 10),
        ]
        for cwd, command, label, expected in cases:
            with self.subTest(owner=label):
                for argument in command:
                    if argument.endswith(".test.ts"):
                        self.assertTrue((ROOT / "opencode" / cwd / argument).is_file(), argument)
                result = run_command(cwd, command, "r2-02-acceptance-" + label)
                self.assertEqual((result["native_tests_passed"], result["native_tests_failed"], result["native_tests_skipped"]),
                    (expected, 0, 0))

    def test_03_real_catalog_discovery_is_separate_from_generation(self):
        result = discovery_smoke()
        self.assertTrue(result["catalog_cli_real_http"])
        self.assertTrue(result["generation_verified_separately"])
        self.assertTrue(result["usage_provenance_survives_restart"])
        self.assertEqual(result["external_model_requests"], 0)
        self.save("discovery", result)

    def test_04_native_credentials_configuration_preserve_existing_session_and_inbox(self):
        result = configuration_smoke()
        self.assertTrue(result["generation_uses_saved_key"])
        self.assertTrue(result["pending_input_and_model_unchanged"])
        self.assertTrue(result["duplicate_and_builtin_id_conflict"])
        self.assertTrue(result["generic_config_remains_denied"])
        self.assertEqual(result["external_model_requests"], 0)
        self.save("configuration", result)

    def test_05_auxiliary_usage_context_and_compaction_survive_native_restart(self):
        result = auxiliary_smoke()
        self.assertTrue(result["selective_accounting_retention"])
        self.assertEqual(result["sources"], ["title", "generate", "compaction"])
        self.assertGreaterEqual(result["model_requests_accounted"], 4)
        self.assertTrue(result["no_auxiliary_double_count"])
        self.assertTrue(result["native_compacted_context_restored"])
        self.assertTrue(result["restart_preserves_totals_and_model_attribution"])
        self.assertEqual(result["native_context_limits"], {"context": 32000, "output": 1024})
        self.assertEqual(result["external_model_requests"], 0)
        self.save("auxiliary", result)

    def test_06_built_settings_browser_and_ci_concurrency(self):
        for label, extra, env, count in [
            ("settings", [], {}, 55),
            ("connection-repeat", ["--grep", "custom API metadata", "--repeat-each=10"], {"PLAYWRIGHT_FULLY_PARALLEL": "1"}, 10),
        ]:
            with self.subTest(owner=label):
                result = run_command("packages/app", ["run", "test:e2e:built", "--", "e2e/regression/settings.spec.ts",
                    "--project", "chromium", "--workers=5", "--retries=0", *extra],
                    "r2-02-acceptance-" + label, extra_env={"PLAYWRIGHT_PORT": "4382", **env})
                self.assertEqual((result["native_tests_passed"], result["native_tests_failed"], result["native_tests_skipped"]), (count, 0, 0))

    def test_07_canonical_native_lint_and_types(self):
        self.assertEqual(run_command(".", ["run", "check"], "r2-02-acceptance-check")["exit_code"], 0)

    @staticmethod
    def save(name, result):
        (ROOT / f".reports/native/r2-02-acceptance-{name}.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    unittest.main()
