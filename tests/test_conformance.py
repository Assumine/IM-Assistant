from dataclasses import asdict
from pathlib import Path
import tempfile
import unittest

from sdk.conformance import ConformanceRunner, Endpoint
from sdk.errors import BackendError
from tests.backend_fixtures.client import FixtureClient

ROOT = Path(__file__).resolve().parents[1]


class ConformanceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        parent = ROOT / "runtime/tests"
        parent.mkdir(parents=True,exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=parent)
        self.clients = []

    async def asyncTearDown(self):
        for client in self.clients:
            await client.close()
        self.temp.cleanup()

    async def runner(self, variant, mutate=None, reconnect_enabled=True, hold_enabled=True):
        current = [None]
        async def start():
            if current[0]:
                await current[0].close()
                self.clients.remove(current[0])
            client = await FixtureClient(variant,Path(self.temp.name)/variant).start()
            current[0] = client
            self.clients.append(client)
            async def call(method, params):
                result = await client.call(method, params)
                return mutate(method,result) if mutate else result
            return Endpoint(call,client.instance,client.generation,"principal-test",{"id":"connection-1","revision":"r-1"})
        async def hold(value):
            await current[0].call("fixture.configure", {"hold":value})
        return ConformanceRunner(await start(),reconnect=start if reconnect_enabled else None,
                                 hold_execution=hold if hold_enabled else None)

    async def test_identical_driver_passes_both_whole_backends(self):
        for variant in ("a","b"):
            with self.subTest(variant=variant):
                report = await (await self.runner(variant)).run()
                self.assertTrue(report.ready, asdict(report))
                self.assertGreater(report.baseline.checks, 20)
                self.assertEqual(report.enabled_capabilities,
                                 ["compact","context_inspect","queue_inspect","queue_reorder","queue_withdraw","usage"])
                self.assertTrue(all(p.checks > 0 for p in report.optional.values() if p.status == "passed"))

    async def test_advertised_but_missing_method_rejected_before_submit(self):
        def mutate(method,result):
            if method == "backend.describe":
                result["methods"].remove("context.compact")
            return result
        runner = await self.runner("a",mutate)
        report = await runner.run()
        self.assertFalse(report.ready)
        self.assertEqual(report.baseline.status,"failed")
        audit = await self.clients[0].call("fixture.inspect")
        self.assertNotIn("inputs.submit",audit["audit"])

    async def test_no_recovery_harness_cannot_claim_complete(self):
        report = await (await self.runner("a",reconnect_enabled=False)).run()
        self.assertFalse(report.ready)
        self.assertEqual(report.baseline.status,"failed")

    async def test_no_pending_harness_does_not_silently_skip_queue_checks(self):
        report = await (await self.runner("b",hold_enabled=False)).run()
        self.assertEqual(report.baseline.status,"passed")
        self.assertFalse(report.ready)
        self.assertEqual(report.optional["queue_withdraw"].status,"unverified")
        self.assertNotIn("queue_withdraw",report.enabled_capabilities)

    async def test_fake_usage_zero_is_rejected_without_disabling_other_probes(self):
        def mutate(method,result):
            if method == "usage.read":
                result["input_tokens"] = 0
            return result
        report = await (await self.runner("a",mutate)).run()
        self.assertEqual(report.baseline.status,"passed")
        self.assertFalse(report.ready)
        self.assertEqual(report.optional["usage"].status,"failed")
        self.assertEqual(report.optional["compact"].status,"passed")

    async def test_final_result_order_violation_is_detected(self):
        def mutate(method,result):
            if method == "events.subscribe":
                for event in result["items"]:
                    if event["type"] == "run.completed":
                        event["sequence"] = 1
            return result
        report = await (await self.runner("b",mutate)).run()
        self.assertFalse(report.ready)
        self.assertEqual(report.baseline.status,"failed")


if __name__ == "__main__":
    unittest.main()
