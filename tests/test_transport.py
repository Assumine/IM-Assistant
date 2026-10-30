import asyncio
import json
import unittest

from sdk.errors import BackendError
from sdk.jsonrpc import FrameDecoder, ProtocolError, encode_frame
from sdk.transport import RpcPeer, default_timeout


class FramingTests(unittest.TestCase):
    def test_partial_utf8_escaped_newline_and_multiple_frames(self):
        packet = {"jsonrpc":"2.0", "id":"h-1", "method":"inputs.submit", "params":{"text":"你好\nnext"}}
        frame = encode_frame(packet)
        decoder = FrameDecoder()
        result = []
        for byte in frame + frame:
            result.extend(decoder.feed(bytes([byte])))
        decoder.finish()
        self.assertEqual(result, [packet, packet])

    def test_invalid_frames_fail_closed(self):
        bad = [b'log: started\n', b'<html>\n', b'{bad}\n', b'\xff\n', b'[]\n', b'\n',
               b'{"jsonrpc":"2.0","id":null,"result":1}\n',
               b'{"jsonrpc":"2.0","id":"h-1","result":1,"error":{}}\n',
               b'{"jsonrpc":"2.0","id":"h-1","result":NaN}\n',
               b'{"jsonrpc":"2.0","id":"h-1","result":1,"result":2}\n']
        for frame in bad:
            with self.subTest(frame=frame), self.assertRaises(ProtocolError):
                FrameDecoder().feed(frame)

    def test_oversize_before_buffer_growth_and_truncated_eof(self):
        decoder = FrameDecoder(128)
        decoder.feed(b"x" * 100)
        with self.assertRaises(ProtocolError):
            decoder.feed(b"y" * 1000)
        self.assertEqual(len(decoder.buffer), 0)
        decoder.feed(b'{"partial":')
        with self.assertRaises(ProtocolError):
            decoder.finish()

    def test_timeout_defaults_are_fixed_and_do_not_limit_model_runtime(self):
        self.assertEqual(default_timeout("backend.describe"), 3)
        self.assertEqual(default_timeout("runtime.hello"), 20)
        self.assertEqual(default_timeout("runtime.drain"), 30)
        self.assertEqual(default_timeout("inputs.submit"), 10)


class TransportTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.peers = []
        self.connections = []
        self.server_tasks = []
        self.server_handler = None
        self.accepted = asyncio.Queue()
        async def accept(reader, writer):
            self.connections.append(writer)
            if self.server_handler:
                task = asyncio.create_task(self.server_handler(reader, writer))
                self.server_tasks.append(task)
            else:
                peer = RpcPeer(reader, writer, direction="b", handler=self.handle).start()
                self.peers.append(peer)
                self.accepted.put_nowait(peer)
        self.server = await asyncio.start_server(accept, "127.0.0.1", 0)

    async def asyncTearDown(self):
        for peer in self.peers:
            await peer.close()
        for task in self.server_tasks:
            task.cancel()
        await asyncio.gather(*self.server_tasks, return_exceptions=True)
        for writer in self.connections:
            writer.close()
            await writer.wait_closed()
        self.server.close()
        await self.server.wait_closed()

    async def handle(self, method, params):
        await asyncio.sleep(params.get("delay", 0))
        return {"method":method, "value":params.get("value")}

    async def connect(self, **kwargs):
        reader, writer = await asyncio.open_connection("127.0.0.1", self.server.sockets[0].getsockname()[1])
        peer = RpcPeer(reader, writer, **kwargs).start()
        self.peers.append(peer)
        return peer

    async def test_concurrent_out_of_order_and_duplex_routing(self):
        client = await self.connect(handler=self.handle)
        remote = await self.accepted.get()
        slow = asyncio.create_task(client.request("history.read", {"delay":0.08, "value":"slow"}))
        fast = await client.request("history.read", {"value":"fast"})
        self.assertEqual(fast["value"], "fast")
        self.assertFalse(slow.done())
        self.assertEqual((await slow)["value"], "slow")
        self.assertEqual((await remote.request("runtime.health"))["method"], "runtime.health")

    async def test_event_does_not_resolve_request(self):
        client = await self.connect()
        remote = await self.accepted.get()
        task = asyncio.create_task(client.request("inputs.submit", {"delay":0.05}))
        await remote.notify("backend.event", {"sequence":1, "type":"input.accepted"})
        self.assertEqual((await client.next_event())["sequence"], 1)
        self.assertFalse(task.done())
        await task

    async def test_timeout_no_cancel_no_retry_late_response_is_harmless(self):
        calls = []
        original = self.handle
        async def handle(method, params):
            calls.append(method)
            return await original(method, params)
        self.handle = handle
        client = await self.connect()
        with self.assertRaises(BackendError) as error:
            await client.request("inputs.submit", {"delay":0.05,"request_id":"original-input"}, timeout=0.01)
        self.assertEqual(error.exception.code, "request_unknown")
        self.assertEqual(error.exception.retry_policy, "query_original")
        self.assertEqual(error.exception.request_id, "original-input")
        await asyncio.sleep(0.08)
        self.assertEqual(calls, ["inputs.submit"])
        self.assertIsNone(client.failure)
        self.assertEqual((await client.request("inputs.lookup"))["method"], "inputs.lookup")

    async def test_disconnect_leaves_mutation_unknown_but_read_unavailable(self):
        client = await self.connect()
        remote = await self.accepted.get()
        tasks = [asyncio.create_task(client.request(m, {"delay":1}))
                 for m in ("inputs.submit", "history.read")]
        await asyncio.sleep(0.03)
        await remote.close()
        results = await asyncio.gather(*tasks, return_exceptions=True)
        self.assertEqual([e.code for e in results], ["request_unknown", "backend_unavailable"])

    async def test_one_poisoned_peer_does_not_block_another(self):
        first = await self.connect()
        poisoned = await self.accepted.get()
        second = await self.connect()
        poisoned.writer.write(b"logging on stdout\n")
        await poisoned.writer.drain()
        await asyncio.wait_for(first._closed.wait(), 1)
        self.assertEqual(first.failure.code, "protocol_error")
        self.assertEqual((await second.request("runtime.health"))["method"], "runtime.health")

    async def test_event_buffer_overflow_is_explicit_and_bounded(self):
        client = await self.connect(max_events=2)
        remote = await self.accepted.get()
        for i in range(3):
            await remote.notify("backend.event", {"sequence":i+1})
        await asyncio.wait_for(client._closed.wait(), 1)
        self.assertEqual(client.failure.code, "backpressure")
        self.assertEqual(client.events.qsize(), 2)
        self.assertEqual((await client.next_event())["sequence"], 1)
        self.assertEqual((await client.next_event())["sequence"], 2)
        with self.assertRaises(BackendError):
            await client.next_event()

    async def test_pending_budget_and_local_oversize_do_not_send(self):
        calls = []
        async def handle(method, params):
            calls.append(method)
            await asyncio.sleep(0.1)
            return {}
        self.handle = handle
        client = await self.connect(max_pending=1, max_frame_bytes=256)
        task = asyncio.create_task(client.request("history.read"))
        await asyncio.sleep(0.03)
        with self.assertRaises(BackendError) as error:
            await client.request("inputs.submit")
        self.assertEqual(error.exception.code, "backpressure")
        await task
        with self.assertRaises(BackendError):
            await client.request("inputs.submit", {"text":"x"*1000})
        with self.assertRaises(BackendError):
            await client.request("inputs.submit", [])
        self.assertEqual(calls, ["history.read"])

    async def test_invalid_direction_and_partial_disconnect(self):
        async def raw(reader, writer):
            await reader.readline()
            writer.write(b'{"jsonrpc":"2.0","id":"b-1","result":1}\n')
            await writer.drain()
        self.server_handler = raw
        client = await self.connect()
        with self.assertRaises(BackendError):
            await client.request("runtime.health")
        self.assertIsNotNone(client.failure)

    async def test_remote_exception_redacted(self):
        async def fail(method, params):
            raise RuntimeError("private-upstream-key")
        self.handle = fail
        client = await self.connect()
        with self.assertRaises(BackendError) as error:
            await client.request("history.read")
        self.assertNotIn("private-upstream-key", str(error.exception))


if __name__ == "__main__":
    unittest.main()
