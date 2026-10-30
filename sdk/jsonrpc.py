"""Strict newline JSON-RPC 2.0 framing, independent of conversation semantics."""

import re

from .contracts import MAX_FRAME_BYTES
from .errors import BackendError
from .manifest import bounded_json, decode_json

ID = re.compile(r"^[hb]-[1-9][0-9]{0,19}$")
METHOD = re.compile(r"^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$")


class ProtocolError(BackendError):
    def __init__(self, message="Invalid backend protocol frame", *, code="protocol_error"):
        super().__init__(code, message)


def validate_packet(value):
    if type(value) is not dict or value.get("jsonrpc") != "2.0":
        raise ProtocolError()
    if "method" in value:
        if set(value) - {"jsonrpc", "id", "method", "params"}:
            raise ProtocolError()
        if type(value["method"]) is not str or not METHOD.fullmatch(value["method"]):
            raise ProtocolError()
        if "params" in value and type(value["params"]) is not dict:
            raise ProtocolError()
    else:
        if "id" not in value or ("result" in value) == ("error" in value):
            raise ProtocolError()
        if set(value) - {"jsonrpc", "id", "result", "error"}:
            raise ProtocolError()
        if "error" in value:
            error = value["error"]
            if (type(error) is not dict or set(error) - {"code", "message", "data"} or
                    type(error.get("code")) is not int or type(error.get("message")) is not str or
                    len(error["message"]) > 1000 or ("data" in error and type(error["data"]) is not dict)):
                raise ProtocolError()
    if "id" in value and (type(value["id"]) is not str or not ID.fullmatch(value["id"])):
        raise ProtocolError()
    return value


def encode_frame(value, *, max_bytes=MAX_FRAME_BYTES):
    validate_packet(value)
    # Include LF in byte budget, consistently on both sides.
    return bounded_json(value, limit=max_bytes - 1) + b"\n"


class FrameDecoder:
    def __init__(self, max_bytes=MAX_FRAME_BYTES):
        if max_bytes < 64:
            raise ValueError("Frame budget too small")
        self.max_bytes = max_bytes
        self.buffer = bytearray()

    def feed(self, chunk: bytes):
        packets = []
        offset = 0
        while offset < len(chunk):
            end = chunk.find(b"\n", offset)
            stop = len(chunk) if end < 0 else end + 1
            if len(self.buffer) + stop - offset > self.max_bytes:
                self.buffer.clear()
                raise ProtocolError("Backend frame exceeds byte limit")
            self.buffer.extend(chunk[offset:stop])
            offset = stop
            if end >= 0:
                frame = bytes(self.buffer[:-1])
                self.buffer.clear()
                try:
                    packets.append(validate_packet(decode_json(frame)))
                except BackendError as error:
                    raise ProtocolError() from error
        return packets

    def finish(self):
        if self.buffer:
            self.buffer.clear()
            raise ProtocolError("Backend disconnected inside a frame")
