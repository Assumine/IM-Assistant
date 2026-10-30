"""Behavioral probes for whole-backend adapters, exclusively in isolated data.

Calling this creates synthetic conversations and inputs. It is never run during
passive discovery, against user production data, or by naming a special backend.
Each advertised optional capability must have a passing probe before activation.
"""

import asyncio
from dataclasses import dataclass, field
from typing import Awaitable, Callable
import uuid

from .errors import BackendError
from .manifest import validate_descriptor, validate_event, validate_message


@dataclass(frozen=True)
class Endpoint:
    call: Callable[[str, dict], Awaitable[dict]]
    instance_id: str
    generation: str
    principal_id: str
    connection_ref: dict

    async def request(self, method, params=None):
        return await self.call(method, {"protocol_version":1,
                                      "backend_instance_id":self.instance_id,
                                      "runtime_generation":self.generation,
                                      "principal_id":self.principal_id, **(params or {})})


@dataclass
class ProbeResult:
    status: str
    checks: int = 0
    reason: str | None = None


@dataclass
class ConformanceReport:
    baseline: ProbeResult = field(default_factory=lambda: ProbeResult("not_run"))
    optional: dict[str, ProbeResult] = field(default_factory=dict)

    @property
    def ready(self):
        return (self.baseline.status == "passed" and self.baseline.checks > 0 and
                all(p.status in ("passed", "not_supported") for p in self.optional.values()))

    @property
    def enabled_capabilities(self):
        if self.baseline.status != "passed":
            return []
        return sorted(key for key, value in self.optional.items() if value.status == "passed")


class ConformanceRunner:
    def __init__(self, endpoint: Endpoint, *, reconnect=None, hold_execution=None, timeout=3):
        self.endpoint = endpoint
        # Harness callbacks operate isolated instance lifecycles, not native DBs.
        self.reconnect = reconnect
        self.hold_execution = hold_execution
        self.timeout = timeout
        self.prefix = "probe-"+uuid.uuid4().hex
        self.checks = 0

    def check(self, condition):
        if not condition:
            raise BackendError("conformance_failed", "Public behavior does not match contract")
        self.checks += 1

    async def call(self, method, params=None):
        return await self.endpoint.request(method, params)

    async def history(self, ref):
        result = await self.call("history.read", {"conversation_ref":ref,"tail":100})
        self.check(isinstance(result.get("items"), list))
        for message in result["items"]:
            validate_message(message)
        orders = [m["order"] for m in result["items"]]
        self.check(orders == sorted(set(orders)))
        self.check(len({m["id"] for m in result["items"]}) == len(result["items"]))
        return result

    async def submit(self, ref, request_id, text="Synthetic conformance input"):
        return await self.call("inputs.submit", {"conversation_ref":ref,"request_id":request_id,
            "connection_ref":self.endpoint.connection_ref,
            "input":{"parts":[{"type":"text","text":text}],"attachments":[]}})

    async def wait_completed(self, ref, request_id):
        async with asyncio.timeout(self.timeout):
            while True:
                lookup = await self.call("inputs.lookup", {"conversation_ref":ref,"request_id":request_id})
                if lookup.get("status") == "accepted" and lookup["receipt"]["execution_state"] == "completed":
                    return lookup["receipt"]
                await asyncio.sleep(0.02)

    async def events(self, cursor=None):
        collected = []
        for _ in range(100):
            page = await self.call("events.subscribe", {"cursor":cursor})
            self.check(isinstance(page.get("items"), list) and isinstance(page.get("cursor"), str))
            for event in page["items"]:
                validate_event(event)
                self.check(event["backend_instance_id"] == self.endpoint.instance_id)
            collected.extend(page["items"])
            new_cursor = page["cursor"]
            if not page.get("has_more"):
                return collected, new_cursor
            self.check(new_cursor != cursor)
            cursor = new_cursor
        raise BackendError("conformance_failed", "Event catch-up did not finish within probe budget")

    async def baseline(self):
        descriptor = validate_descriptor(await self.call("backend.describe"))
        connections = await self.call("connections.list")
        self.check(any(item["id"] == self.endpoint.connection_ref["id"] and
                       item["revision"] == self.endpoint.connection_ref["revision"]
                       for item in connections["items"]))
        params = {"request_id":self.prefix+"-open","mode":"create","connection_ref":self.endpoint.connection_ref}
        ref = (await self.call("conversations.open", params))["conversation_ref"]
        self.check(ref == (await self.call("conversations.open", params))["conversation_ref"])
        self.check(ref["backend_instance_id"] == self.endpoint.instance_id)
        listed = await self.call("conversations.list")
        self.check(sum(item["conversation_ref"] == ref for item in listed["items"]) == 1)
        request_id = self.prefix+"-input"
        receipt = await self.submit(ref, request_id)
        self.check(receipt["accepted"] is True and receipt["durable"] is True and bool(receipt["receipt_id"]))
        duplicate = await self.submit(ref, request_id)
        self.check(duplicate["native_input_id"] == receipt["native_input_id"])
        try:
            await self.submit(ref, request_id, text="Different content under same request ID")
        except BackendError as error:
            self.check(error.code == "idempotency_conflict")
        else:
            self.check(False)
        await self.wait_completed(ref, request_id)
        history = await self.history(ref)
        self.check(sum(m["role"] == "user" and m["request_id"] == request_id for m in history["items"]) == 1)
        final_ids = {m["id"] for m in history["items"] if m["phase"] == "final" and m["role"] == "assistant"}
        self.check(bool(final_ids))
        events, cursor = await self.events()
        relevant = [e for e in events if e["request_id"] == request_id]
        identities = [(e["stream_id"],e["event_id"]) for e in relevant]
        self.check(len(set(identities)) == len(identities))
        sequences = [e["sequence"] for e in relevant]
        self.check(sequences == sorted(set(sequences)))
        commits = [e for e in relevant if e["type"] == "message.committed" and e["payload"]["message"]["id"] in final_ids]
        completed = [e for e in relevant if e["type"] == "run.completed"]
        self.check(bool(commits) and len(completed) == 1)
        self.check(max(e["sequence"] for e in commits) < completed[0]["sequence"])
        self.check(set(completed[0]["payload"]["result_message_ids"]) <= final_ids)
        self.check(any(e["type"] == "input.applied" for e in relevant))
        snapshot = await self.call("state.snapshot", {"conversation_ref":ref})
        self.check(snapshot["stream_id"] == completed[0]["stream_id"] and snapshot["through_sequence"] >= completed[0]["sequence"])
        if self.reconnect is None:
            raise BackendError("conformance_incomplete", "Restart/reconnect harness is required for durable delivery probes")
        self.endpoint = await self.reconnect()
        self.check(ref == (await self.call("conversations.open",params))["conversation_ref"])
        recovered = await self.call("inputs.lookup", {"conversation_ref":ref,"request_id":request_id})
        self.check(recovered["receipt"]["native_input_id"] == receipt["native_input_id"])
        self.check((await self.history(ref))["items"] == history["items"])
        replay, _ = await self.events(cursor)
        self.check(not any(e["request_id"] == request_id for e in replay))
        original, _ = await self.events()
        self.check([(e["stream_id"],e["event_id"]) for e in original if e["request_id"] == request_id] == identities)
        return descriptor, ref

    async def optional_probe(self, capability, ref):
        if capability == "queue_inspect":
            result = await self.call("queue.snapshot", {"conversation_ref":ref})
            self.check(isinstance(result.get("revision"), str) and isinstance(result.get("items"), list))
        elif capability in ("queue_withdraw", "queue_reorder"):
            if self.hold_execution is None:
                return ProbeResult("unverified", reason="Pending-input harness is required")
            await self.hold_execution(True)
            try:
                first = await self.submit(ref,self.prefix+"-"+capability+"-1")
                second = await self.submit(ref,self.prefix+"-"+capability+"-2")
                self.check(first["execution_state"] == second["execution_state"] == "queued")
                queue = await self.call("queue.snapshot", {"conversation_ref":ref})
                if capability == "queue_reorder":
                    ids = [second["native_input_id"],first["native_input_id"]]
                    await self.call("queue.reorder", {"conversation_ref":ref,"expected_revision":queue["revision"],"native_input_ids":ids})
                    queue = await self.call("queue.snapshot", {"conversation_ref":ref})
                    self.check([i["native_input_id"] for i in queue["items"]] == ids)
                else:
                    await self.call("queue.withdraw", {"conversation_ref":ref,"expected_revision":queue["revision"],"native_input_id":first["native_input_id"]})
                    after = await self.call("queue.snapshot", {"conversation_ref":ref})
                    self.check(first["native_input_id"] not in {i["native_input_id"] for i in after["items"]})
                    try:
                        await self.call("queue.withdraw", {"conversation_ref":ref,"expected_revision":queue["revision"],"native_input_id":second["native_input_id"]})
                    except BackendError as error:
                        self.check(error.code == "revision_conflict")
                    else:
                        self.check(False)
            finally:
                await self.hold_execution(False)
            await self.wait_completed(ref,self.prefix+"-"+capability+"-2")
            if capability == "queue_reorder":
                await self.wait_completed(ref,self.prefix+"-"+capability+"-1")
        elif capability == "context_inspect":
            result = await self.call("context.inspect", {"conversation_ref":ref})
            self.check(result.get("owner") == "backend" and isinstance(result.get("source"), str))
        elif capability == "compact":
            before = await self.history(ref)
            _, cursor = await self.events()
            result = await self.call("context.compact", {"conversation_ref":ref})
            self.check(result.get("status") == "completed")
            self.check((await self.history(ref))["items"] == before["items"])
            events, _ = await self.events(cursor)
            self.check(any(e["type"] == "context.compacted" and e["conversation_ref"] == ref for e in events))
        elif capability == "usage":
            result = await self.call("usage.read", {"conversation_ref":ref})
            self.check(result.get("source") in ("backend_reported","estimated","not_reported"))
            if result["source"] == "not_reported":
                self.check(result.get("input_tokens") is None and result.get("output_tokens") is None and result.get("cost") is None)
        else:
            return ProbeResult("unverified", reason="No behavioral probe for this optional capability yet")
        return None

    async def run(self):
        report = ConformanceReport()
        try:
            async with asyncio.timeout(self.timeout * 10):
                descriptor, ref = await self.baseline()
            report.baseline = ProbeResult("passed", self.checks)
        except Exception as error:
            report.baseline = ProbeResult("failed", self.checks, type(error).__name__)
            return report
        for capability, supported in descriptor.capabilities.items():
            if not supported:
                report.optional[capability] = ProbeResult("not_supported")
                continue
            before = self.checks
            try:
                async with asyncio.timeout(self.timeout * 3):
                    result = await self.optional_probe(capability, ref)
                report.optional[capability] = result or ProbeResult("passed", self.checks-before)
            except Exception as error:
                report.optional[capability] = ProbeResult("failed", self.checks-before, type(error).__name__)
        return report
