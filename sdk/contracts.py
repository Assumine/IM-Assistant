"""V1 public shapes. Native identifiers remain bounded opaque strings.

TypedDicts document the wire; validation at trust boundaries lives in manifest.py.
No object here knows a backend's private database or execution scheduler.
"""

from dataclasses import dataclass
from types import MappingProxyType
from typing import Literal, Mapping, NotRequired, TypedDict

PROTOCOL_VERSION = 1
MAX_FRAME_BYTES = 4 * 1024 * 1024
MAX_RESOURCE_CHUNK_BYTES = 256 * 1024
REQUIRED_METHODS = frozenset({
    "backend.describe", "connections.list", "conversations.list",
    "conversations.open", "history.read", "inputs.submit", "inputs.lookup",
    "events.subscribe", "state.snapshot",
})
LIFECYCLE_METHODS = frozenset({
    "runtime.hello", "runtime.health", "runtime.drain", "runtime.stop",
})
CAPABILITY_METHODS = MappingProxyType({
    "queue_inspect": "queue.snapshot", "queue_reorder": "queue.reorder",
    "queue_withdraw": "queue.withdraw", "input_adjust": "inputs.adjust",
    "cancel_run": "runs.cancel", "pause_run": "runs.pause",
    "resume_run": "runs.resume", "context_inspect": "context.inspect",
    "compact": "context.compact", "usage": "usage.read",
    "session_export": "conversations.export",
    "human_interaction": "interactions.respond",
    "connection_setup": "connections.configure", "resources": "resources.read",
})


class ConversationRef(TypedDict):
    conversation_id: str
    backend_instance_id: str
    native_conversation_id: str


class ConnectionRef(TypedDict):
    id: str
    revision: str


class ResourceRef(TypedDict):
    id: str
    backend_instance_id: str
    conversation_id: str
    mime_type: str
    size_bytes: int
    expires_at: str | None


class Message(TypedDict):
    id: str
    revision: int
    order: int
    role: Literal["user", "assistant", "tool", "system"]
    phase: Literal["pending", "commentary", "final"]
    request_id: str | None
    native_input_id: str | None
    native_run_id: str | None
    text: NotRequired[str]
    resource_ref: NotRequired[ResourceRef]
    attachments: NotRequired[list[ResourceRef]]


class BackendEvent(TypedDict):
    protocol_version: int
    backend_instance_id: str
    stream_id: str
    sequence: int
    event_id: str
    runtime_generation: str
    occurred_at: str
    type: str
    conversation_ref: ConversationRef | None
    request_id: str | None
    native_input_id: str | None
    native_run_id: str | None
    payload: dict


class InputReceipt(TypedDict):
    request_id: str
    accepted: bool
    durable: bool
    native_input_id: str | None
    native_run_id: str | None
    execution_state: str
    receipt_id: str | None
    queue_revision: str | None


class ResourceRead(TypedDict):
    principal_id: str
    conversation_ref: ConversationRef
    resource_ref: ResourceRef
    offset: int
    limit: int


class ResourceChunk(TypedDict):
    resource_ref: ResourceRef
    offset: int
    data_base64: str
    eof: bool


@dataclass(frozen=True)
class BackendDescriptor:
    backend_id: str
    backend_version: str
    methods: frozenset[str]
    capabilities: Mapping[str, bool]

    def supports(self, capability: str) -> bool:
        return self.capabilities.get(capability, False)

    def require(self, capability: str) -> str:
        from .errors import BackendError
        method = CAPABILITY_METHODS.get(capability)
        if not self.supports(capability) or method is None or method not in self.methods:
            raise BackendError("unsupported_capability", "Backend does not support this operation")
        return method
