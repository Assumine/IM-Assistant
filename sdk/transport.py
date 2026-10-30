"""Bounded asynchronous duplex RPC. Timeouts never cancel or resubmit a run.

This layer only transfers packets. It owns no session execution queue, process,
retry loop, or durable cursor. On overload the consumer must resume from its
persisted source cursor after reconnecting; unpersisted frames are not ACKed.
"""

import asyncio
from collections import deque
from dataclasses import dataclass

from .contracts import MAX_FRAME_BYTES
from .errors import BackendError, RetryPolicy
from .jsonrpc import FrameDecoder, ProtocolError, encode_frame

METADATA_TIMEOUT = 3.0
HELLO_TIMEOUT = 20.0
COMMAND_TIMEOUT = 10.0
DRAIN_TIMEOUT = 30.0
MAX_PENDING = 256
MAX_EVENTS = 256
READ_METHODS = frozenset({
    "backend.describe", "runtime.hello", "runtime.health", "connections.list",
    "conversations.list", "history.read", "inputs.lookup", "events.subscribe",
    "state.snapshot", "queue.snapshot", "context.inspect", "usage.read", "resources.read",
})


def default_timeout(method):
    if method == "runtime.hello":
        return HELLO_TIMEOUT
    if method == "runtime.drain":
        return DRAIN_TIMEOUT
    return METADATA_TIMEOUT if method in READ_METHODS else COMMAND_TIMEOUT


def _delivery_error(method, reason, request_id=None):
    if method not in READ_METHODS:
        return BackendError("request_unknown", reason, retry_policy=RetryPolicy.QUERY_ORIGINAL, request_id=request_id)
    return BackendError("backend_unavailable", reason, retry_policy=RetryPolicy.BOUNDED_READ, request_id=request_id)


@dataclass
class _Pending:
    method: str
    future: asyncio.Future
    request_id: str | None


class RpcPeer:
    def __init__(self, reader, writer, *, direction="h", handler=None,
                 max_frame_bytes=MAX_FRAME_BYTES, max_pending=MAX_PENDING, max_events=MAX_EVENTS):
        if direction not in ("h", "b") or max_pending < 1 or max_events < 1:
            raise ValueError("Invalid peer limits or direction")
        self.reader, self.writer = reader, writer
        self.direction = direction
        self.remote_direction = "b" if direction == "h" else "h"
        self.handler = handler
        self.decoder = FrameDecoder(max_frame_bytes)
        self.max_pending = max_pending
        self.events = asyncio.Queue(maxsize=max_events)
        self._pending = {}
        self._retired = deque(maxlen=512)
        self._incoming = set()
        self._counter = 0
        self._write_lock = asyncio.Lock()
        self._workers = set()
        self._reader_task = None
        self._closed = asyncio.Event()
        self.failure = None

    def start(self):
        if self._reader_task is not None:
            raise RuntimeError("Peer already started")
        self._reader_task = asyncio.create_task(self._read_loop())
        return self

    async def _write(self, packet):
        data = encode_frame(packet, max_bytes=self.decoder.max_bytes)
        if self._closed.is_set():
            raise BackendError("backend_unavailable", "Backend channel is closed")
        async with self._write_lock:
            self.writer.write(data)
            await self.writer.drain()

    async def request(self, method, params=None, *, timeout=None):
        if self._closed.is_set():
            raise BackendError("backend_unavailable", "Backend channel is closed")
        if len(self._pending) >= self.max_pending:
            raise BackendError("backpressure", "Too many outstanding RPC requests")
        self._counter += 1
        ident = f"{self.direction}-{self._counter}"
        packet = {"jsonrpc":"2.0", "id":ident, "method":method, "params":{} if params is None else params}
        # Reject malformed/oversized local data before creating delivery uncertainty.
        encode_frame(packet, max_bytes=self.decoder.max_bytes)
        request_id = packet["params"].get("request_id")
        future = asyncio.get_running_loop().create_future()
        self._pending[ident] = _Pending(method, future, request_id)
        try:
            async with asyncio.timeout(default_timeout(method) if timeout is None else timeout):
                await self._write(packet)
                return await asyncio.shield(future)
        except TimeoutError as error:
            raise _delivery_error(method, "Backend acknowledgement timed out; check original request", request_id) from error
        except (ConnectionError, OSError) as error:
            self._abort(ProtocolError("Backend channel disconnected"))
            raise _delivery_error(method, "Backend channel disconnected; check original request", request_id) from error
        finally:
            self._pending.pop(ident, None)
            self._retired.append(ident)
            if not future.done():
                future.cancel()
            elif not future.cancelled():
                future.exception()  # Consume an exception even if write/timeout failed first.

    async def notify(self, method, params):
        async with asyncio.timeout(COMMAND_TIMEOUT):
            await self._write({"jsonrpc":"2.0", "method":method, "params":params})

    async def next_event(self):
        # Buffered events may still be persisted before reconnecting.
        if not self.events.empty():
            return self.events.get_nowait()
        if self._closed.is_set():
            raise self.failure or BackendError("backend_unavailable", "Backend channel closed")
        get = asyncio.create_task(self.events.get())
        closed = asyncio.create_task(self._closed.wait())
        try:
            await asyncio.wait((get, closed), return_when=asyncio.FIRST_COMPLETED)
            if get.done():
                return get.result()
            raise self.failure or BackendError("backend_unavailable", "Backend channel closed")
        finally:
            for task in (get, closed):
                if not task.done():
                    task.cancel()
            await asyncio.gather(get, closed, return_exceptions=True)

    def _abort(self, error):
        if self._closed.is_set():
            return
        self.failure = error
        self._closed.set()
        self.writer.close()
        for pending in self._pending.values():
            if not pending.future.done():
                pending.future.set_exception(_delivery_error(pending.method, error.message, pending.request_id))

    async def _read_loop(self):
        try:
            while chunk := await self.reader.read(4096):
                for packet in self.decoder.feed(chunk):
                    self._route(packet)
            self.decoder.finish()
            self._abort(ProtocolError("Backend channel disconnected"))
        except asyncio.CancelledError:
            raise
        except BackendError as error:
            self._abort(error)
        except Exception:
            self._abort(ProtocolError("Backend channel read failed"))

    def _route(self, packet):
        ident = packet.get("id")
        if "method" not in packet:
            if not ident.startswith(self.direction + "-"):
                raise ProtocolError("Response has wrong direction")
            pending = self._pending.get(ident)
            if not pending:
                if ident in self._retired:
                    return  # Timed-out/cancelled calls can acknowledge later.
                raise ProtocolError("Response has unknown RPC identity")
            if pending.future.done():
                raise ProtocolError("Duplicate RPC response")
            if "result" in packet:
                pending.future.set_result(packet["result"])
            else:
                error = packet["error"]
                data = error.get("data", {})
                policy = data.get("retry_policy", "never")
                try:
                    policy = RetryPolicy(policy)
                except ValueError:
                    raise ProtocolError("Invalid retry policy")
                # Do not expose untrusted upstream error messages or arbitrary data.
                code = data.get("code", "remote_error")
                if not isinstance(code, str) or len(code) > 80:
                    raise ProtocolError("Invalid error code")
                pending.future.set_exception(BackendError(code, "Backend rejected request", retry_policy=policy))
            return
        if ident is None:
            if packet["method"] != "backend.event":
                raise ProtocolError("Unknown notification method")
            try:
                self.events.put_nowait(packet.get("params", {}))
            except asyncio.QueueFull:
                raise ProtocolError("Event buffer full; resume from durable cursor", code="backpressure")
            return
        if not ident.startswith(self.remote_direction + "-") or ident in self._incoming:
            raise ProtocolError("Invalid or duplicate incoming RPC identity")
        if len(self._incoming) >= self.max_pending:
            raise ProtocolError("Incoming RPC budget exceeded", code="backpressure")
        self._incoming.add(ident)
        task = asyncio.create_task(self._dispatch(packet))
        self._workers.add(task)
        task.add_done_callback(self._workers.discard)

    async def _dispatch(self, packet):
        ident = packet["id"]
        try:
            if self.handler is None:
                raise BackendError("unsupported_method", "No public handler for method")
            result = await self.handler(packet["method"], packet.get("params", {}))
            response = {"jsonrpc":"2.0", "id":ident, "result":result}
        except BackendError as error:
            response = {"jsonrpc":"2.0", "id":ident,
                        "error":{"code":-32000, "message":"Backend request failed", "data":error.to_dict()}}
        except Exception:
            response = {"jsonrpc":"2.0", "id":ident,
                        "error":{"code":-32603, "message":"Backend request failed"}}
        try:
            async with asyncio.timeout(COMMAND_TIMEOUT):
                await self._write(response)
        except asyncio.CancelledError:
            raise
        except Exception:
            self._abort(ProtocolError("Backend response write failed"))
        finally:
            self._incoming.discard(ident)

    async def close(self):
        self._abort(ProtocolError("Backend channel closed locally"))
        tasks = [t for t in [self._reader_task, *self._workers] if t is not None]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if hasattr(self.writer, "wait_closed"):
            try:
                async with asyncio.timeout(1):
                    await self.writer.wait_closed()
            except (TimeoutError, ConnectionError, OSError):
                pass
