import asyncio
from pathlib import Path
import tempfile
import unittest

from sdk.errors import BackendError
from sdk.manifest import validate_descriptor, validate_event, validate_message
from tests.backend_fixtures.client import FixtureClient

ROOT = Path(__file__).resolve().parents[1]


class BackendFixtureTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        parent = ROOT / "runtime/tests"
        parent.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=parent)
        self.clients = []

    async def asyncTearDown(self):
        for client in self.clients:
            await client.close()
        self.temp.cleanup()

    async def start(self, variant, name=None):
        name = name or variant
        client = FixtureClient(variant, Path(self.temp.name)/name, "instance-"+name)
        self.clients.append(client)
        return await client.start()

    async def test_same_public_loop_drives_two_native_formats(self):
        formats = set()
        native_ids = set()
        for variant in ("a", "b"):
            with self.subTest(variant=variant):
                client = await self.start(variant)
                descriptor = validate_descriptor(await client.call("backend.describe"))
                self.assertTrue(descriptor.supports("compact"))
                ref = await client.open()
                native_ids.add(ref["native_conversation_id"].split("/")[0])
                receipt = await client.submit(ref)
                self.assertEqual(receipt["execution_state"], "queued")
                self.assertIsNone(receipt["native_run_id"])
                await client.completed(ref)
                history = await client.call("history.read", {"conversation_ref":ref,"tail":10})
                self.assertEqual([m["role"] for m in history["items"]], ["user","assistant"])
                for message in history["items"]:
                    validate_message(message)
                await client.call("context.compact", {"conversation_ref":ref})
                after = await client.call("history.read", {"conversation_ref":ref,"tail":10})
                self.assertEqual(history["items"], after["items"])
                events = await client.call("events.subscribe")
                for event in events["items"]:
                    validate_event(event)
                types = [e["type"] for e in events["items"]]
                self.assertLess(types.index("message.committed",types.index("input.applied")), types.index("run.completed"))
                audit = await client.call("fixture.inspect")
                formats.add(audit["format"])
                self.assertEqual(audit["tool_count"], 1)
                self.assertEqual(audit["context_count"], 1)
        self.assertEqual(len(formats), 2)
        self.assertEqual(len(native_ids), 2)

    async def test_retry_and_reconnect_preserve_native_session_and_execution(self):
        for variant in ("a", "b"):
            with self.subTest(variant=variant):
                client = await self.start(variant)
                ref = await client.open()
                await client.submit(ref)
                await client.completed(ref)
                initial = await client.call("events.subscribe")
                await client.close()
                self.clients.remove(client)
                restarted = await self.start(variant)
                self.assertEqual(await restarted.open(), ref)
                receipt = await restarted.submit(ref)
                self.assertEqual(receipt["execution_state"], "completed")
                self.assertEqual((await restarted.call("fixture.inspect"))["tool_count"], 1)
                replay = await restarted.call("events.subscribe", {"cursor":initial["cursor"]})
                self.assertEqual(replay["items"], [])
                self.assertEqual(replay["cursor"], initial["cursor"])
                with self.assertRaises(BackendError) as error:
                    await restarted.submit(ref,text="changed body")
                self.assertEqual(error.exception.code, "idempotency_conflict")

    async def test_two_instances_and_principals_are_isolated(self):
        a = await self.start("a", "a1")
        b = await self.start("a", "a2")
        ref = await a.open()
        self.assertEqual((await b.call("conversations.list"))["items"], [])
        with self.assertRaises(BackendError) as error:
            await b.call("history.read", {"conversation_ref":ref,"tail":10})
        self.assertEqual(error.exception.code, "permission_denied")
        self.assertEqual((await a.call("conversations.list", principal="another-person"))["items"], [])
        with self.assertRaises(BackendError):
            await a.call("history.read", {"conversation_ref":ref,"tail":10}, principal="another-person")
        events_a = await a.call("events.subscribe")
        events_b = await b.call("events.subscribe")
        self.assertNotEqual(events_a["cursor"], events_b["cursor"])
        with self.assertRaises(BackendError):
            await b.call("events.subscribe", {"cursor":events_a["cursor"]})

    async def test_attach_reuses_authorized_native_identity(self):
        client = await self.start("a")
        ref = await client.open()
        result = await client.call("conversations.open", {"request_id":"attach-1","mode":"attach",
                                   "native_conversation_id":ref["native_conversation_id"]})
        self.assertEqual(result["conversation_ref"],ref)
        self.assertEqual(len((await client.call("conversations.list"))["items"]),1)
        with self.assertRaises(BackendError):
            await client.call("conversations.open", {"request_id":"attach-other","mode":"attach",
                              "native_conversation_id":ref["native_conversation_id"]},principal="other-person")

    async def test_native_queue_withdraw_and_revision_conflict(self):
        for variant in ("a", "b"):
            with self.subTest(variant=variant):
                client = await self.start(variant)
                ref = await client.open()
                await client.call("fixture.configure", {"hold":True})
                first = await client.submit(ref, "first")
                second = await client.submit(ref, "second")
                queue = await client.call("queue.snapshot", {"conversation_ref":ref})
                result = await client.call("queue.reorder", {"conversation_ref":ref,"expected_revision":queue["revision"],
                                           "native_input_ids":[second["native_input_id"],first["native_input_id"]]})
                with self.assertRaises(BackendError) as error:
                    await client.call("queue.withdraw", {"conversation_ref":ref,"expected_revision":queue["revision"],
                                      "native_input_id":first["native_input_id"]})
                self.assertEqual(error.exception.code, "revision_conflict")
                await client.call("queue.withdraw", {"conversation_ref":ref,"expected_revision":result["revision"],
                                  "native_input_id":first["native_input_id"]})
                await client.call("fixture.configure", {"hold":False})
                await client.completed(ref, "second")
                self.assertEqual((await client.call("fixture.inspect"))["tool_count"], 1)
                self.assertEqual((await client.call("inputs.lookup", {"conversation_ref":ref,"request_id":"first"}))["receipt"]["execution_state"], "withdrawn")

    async def test_ack_lost_is_queried_without_resubmitting(self):
        client = await self.start("a")
        ref = await client.open()
        await client.call("fixture.configure", {"ack_delay":0.1})
        with self.assertRaises(BackendError) as error:
            await client.submit(ref, timeout=0.01)
        self.assertEqual(error.exception.code, "request_unknown")
        await client.completed(ref)
        self.assertEqual((await client.call("fixture.inspect"))["tool_count"], 1)
        self.assertEqual((await client.call("fixture.inspect"))["audit"].count("inputs.submit"), 1)

    async def test_stable_pagination_and_owner_scoped_cursor(self):
        client = await self.start("b")
        ref = await client.open()
        for number in range(4):
            await client.submit(ref,"input-"+str(number))
            await client.completed(ref,"input-"+str(number))
        tail = await client.call("history.read", {"conversation_ref":ref,"tail":2})
        before = await client.call("history.read", {"conversation_ref":ref,"before":tail["before_cursor"],"limit":2})
        self.assertEqual([m["order"] for m in before["items"]+tail["items"]], [5,6,7,8])
        other = await client.open("other")
        with self.assertRaises(BackendError):
            await client.call("history.read", {"conversation_ref":other,"before":tail["before_cursor"],"limit":2})

    async def test_queued_input_survives_shutdown_without_new_identity(self):
        client = await self.start("a")
        ref = await client.open()
        await client.call("fixture.configure", {"hold":True})
        receipt = await client.submit(ref)
        await client.close()
        self.clients.remove(client)
        restarted = await self.start("a")
        lookup = await restarted.call("inputs.lookup", {"conversation_ref":ref,"request_id":"input-test"})
        self.assertEqual(lookup["receipt"]["native_input_id"], receipt["native_input_id"])
        queue = await restarted.call("queue.snapshot", {"conversation_ref":ref})
        self.assertEqual(len(queue["items"]), 1)
        await restarted.call("fixture.configure", {"hold":False})
        await restarted.completed(ref)
        self.assertEqual((await restarted.call("fixture.inspect"))["tool_count"], 1)

    async def test_old_generation_cannot_mutate_but_old_events_remain_readable(self):
        client = await self.start("b")
        ref = await client.open()
        old = client.generation
        await client.submit(ref)
        await client.completed(ref)
        await client.close()
        self.clients.remove(client)
        client = await self.start("b")
        with self.assertRaises(BackendError) as error:
            await client.call("inputs.submit", {"conversation_ref":ref,"runtime_generation":old})
        self.assertEqual(error.exception.code, "stale_generation")
        events = await client.call("events.subscribe")
        self.assertEqual({e["runtime_generation"] for e in events["items"]}, {old})


if __name__ == "__main__":
    unittest.main()
