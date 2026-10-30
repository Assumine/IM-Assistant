"""Shared *test* facade with fault controls; each store owns native state.

The synthetic execution is deterministic and performs no external side effects.
Production host code must never import these fixtures or fixture.* methods.
"""

import argparse
import asyncio
import base64
import copy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
import uuid

from sdk.contracts import CAPABILITY_METHODS, LIFECYCLE_METHODS, REQUIRED_METHODS
from sdk.errors import BackendError
from sdk.manifest import bounded_json
from sdk.transport import RpcPeer


def now():
    return datetime.now(timezone.utc).isoformat()


def token(value):
    return base64.urlsafe_b64encode(json.dumps(value, sort_keys=True).encode()).decode()


def untoken(value):
    try:
        return json.loads(base64.urlsafe_b64decode(value.encode()))
    except Exception as error:
        raise BackendError("cursor_expired", "Cursor cannot be resumed") from error


class BackendFixture:
    def __init__(self, store, instance_id, generation):
        self.store, self.instance_id, self.generation = store, instance_id, generation
        self.state = store.load() or {"instance_id":instance_id, "stream_id":"stream-"+uuid.uuid4().hex,
                                     "events":[], "requests":{}, "conversations":{}}
        if self.state["instance_id"] != instance_id:
            raise ValueError("Fixture data directory belongs to another instance")
        self.peer = None
        self.subscriber = None
        self.tasks = set()
        self.held = False
        self.ack_delay = 0
        self.audit = []
        self.backend_id = "fixture-backend"
        self.capabilities = {key: key in {"queue_inspect", "queue_reorder", "queue_withdraw",
                            "context_inspect", "compact", "usage"}
                             for key in (*CAPABILITY_METHODS, "attachments")}
        # Interrupted execution is never silently rerun on process restart.
        for conversation in self.state["conversations"].values():
            if conversation["running"] is not None:
                conversation["recovery_required"] = True
        self.save()

    def save(self):
        self.store.save(self.state)

    def describe(self):
        return {"protocol_version":1, "backend_id":self.backend_id, "backend_version":"0.0.1",
                "display_name":"Synthetic complete backend", "ownership":{k:"backend" for k in
                ("history","context","queue","tools","compaction")},
                "methods":sorted(REQUIRED_METHODS | LIFECYCLE_METHODS |
                                 {method for key,method in CAPABILITY_METHODS.items() if self.capabilities[key]}),
                "capabilities":self.capabilities,
                "delivery_guarantees":{k:True for k in ("durable_request_identity", "query_after_disconnect",
                                                        "ordered_resumable_events", "stable_history_cursor")}}

    def principal(self, params):
        principal = params.get("principal_id")
        if not isinstance(principal, str) or not principal or len(principal) > 160:
            raise BackendError("permission_denied", "Authorized principal is required")
        return principal

    def conversation(self, params):
        principal = self.principal(params)
        ref = params.get("conversation_ref", {})
        conversation = self.state["conversations"].get(ref.get("conversation_id"))
        if (not conversation or conversation["principal"] != principal or
                ref.get("backend_instance_id") != self.instance_id or
                ref.get("native_conversation_id") != conversation["native_id"]):
            raise BackendError("permission_denied", "Conversation is outside authorized scope")
        return conversation

    def ref(self, conversation):
        return {"conversation_id":conversation["id"], "backend_instance_id":self.instance_id,
                "native_conversation_id":conversation["native_id"]}

    def fingerprint(self, method, params):
        return hashlib.sha256(bounded_json({"method":method, "params":{k:v for k,v in params.items()
                                       if k not in ("runtime_generation", "protocol_version")}})).hexdigest()

    def existing(self, method, params):
        principal = self.principal(params)
        request_id = params.get("request_id")
        if not isinstance(request_id, str) or not request_id:
            raise BackendError("invalid_request", "A stable request ID is required")
        key = token([principal, request_id])
        previous = self.state["requests"].get(key)
        if previous and previous["fingerprint"] != self.fingerprint(method, params):
            raise BackendError("idempotency_conflict", "Request ID has different parameters")
        return key, previous

    def emit(self, conversation, typ, payload, receipt=None):
        event = {"protocol_version":1,"backend_instance_id":self.instance_id,
                 "stream_id":self.state["stream_id"],"sequence":len(self.state["events"])+1,
                 "event_id":"event-"+str(len(self.state["events"])+1),
                 "runtime_generation":self.generation,"occurred_at":now(),"type":typ,
                 "conversation_ref":self.ref(conversation),
                 "request_id":receipt["request_id"] if receipt else None,
                 "native_input_id":receipt["native_input_id"] if receipt else None,
                 "native_run_id":receipt["native_run_id"] if receipt else None,"payload":payload}
        self.state["events"].append(event)

    def spawn(self, coroutine):
        task = asyncio.create_task(coroutine)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    def kick(self, conversation):
        if not self.held and not conversation["running"] and conversation["queue"] and not conversation["recovery_required"]:
            # One native worker per conversation. The host never starts its next item.
            key = conversation["queue"].pop(0)
            conversation["running"] = key
            conversation["queue_revision"] += 1
            self.save()
            self.spawn(self.execute(conversation, key))

    async def execute(self, conversation, key):
        receipt = self.state["requests"][key]["result"]
        receipt.update(native_run_id=self.store.native_prefix+"run/"+uuid.uuid4().hex, execution_state="running")
        self.emit(conversation, "run.started", {"execution_state":"running"}, receipt)
        self.emit(conversation, "input.applied", {"execution_state":"running"}, receipt)
        self.save()
        await asyncio.sleep(0.02)
        conversation["tool_count"] += 1  # Synthetic backend-owned tool, no external action.
        message = {"id":self.store.native_prefix+"message/"+uuid.uuid4().hex,
                   "revision":1,"order":len(conversation["messages"])+1,"role":"assistant","phase":"final",
                   "request_id":receipt["request_id"],"native_input_id":receipt["native_input_id"],
                   "native_run_id":receipt["native_run_id"],"text":"Synthetic result: "+self.state["requests"][key]["text"]}
        conversation["messages"].append(message)
        self.store.update_context(conversation["context"], message["text"])
        self.emit(conversation, "message.committed", {"message":message}, receipt)
        self.emit(conversation, "run.completed", {"result_message_ids":[message["id"]],"execution_state":"completed"}, receipt)
        receipt["execution_state"] = "completed"
        conversation["running"] = None
        self.save()
        self.spawn(self.push_events())
        self.kick(conversation)

    async def push_events(self):
        if not self.subscriber or not self.peer:
            return
        principal, sequence = self.subscriber
        batch = [event for event in self.state["events"] if event["sequence"] > sequence]
        self.subscriber = (principal, len(self.state["events"]))
        for event in batch:
            conversation = self.state["conversations"][event["conversation_ref"]["conversation_id"]]
            if conversation["principal"] == principal:
                try:
                    await self.peer.notify("backend.event", event)
                except (BackendError, ConnectionError, OSError):
                    return  # Reconnect replays from caller's durable cursor.

    async def handle(self, method, params):
        self.audit.append(method)
        if len(self.audit) > 1000:
            self.audit.pop(0)
        if method == "fixture.configure":
            self.held = params.get("hold", self.held)
            self.ack_delay = params.get("ack_delay", self.ack_delay)
            for conversation in self.state["conversations"].values():
                self.kick(conversation)
            return {"held":self.held}
        if method == "fixture.inspect":
            return {"format":self.store.format_name,"audit":list(self.audit),
                    "tool_count":sum(c["tool_count"] for c in self.state["conversations"].values()),
                    "context_count":len(self.state["conversations"])}
        if method not in self.describe()["methods"]:
            raise BackendError("unsupported_capability", "Operation is not supported")
        if method == "backend.describe":
            return self.describe()
        if method == "runtime.hello":
            if params.get("backend_instance_id") != self.instance_id or params.get("runtime_generation") != self.generation:
                raise BackendError("permission_denied", "Instance generation does not match")
            return {"backend_instance_id":self.instance_id,"runtime_generation":self.generation,
                    "protocol_version":1,"state":"ready","data_version":"1","backend_id":self.backend_id}
        if method == "runtime.health":
            return {"state":"ready","connection_state":"available"}
        if method == "runtime.drain":
            self.held = True
            self.save()
            return {"in_flight":sum(c["running"] is not None for c in self.state["conversations"].values()),
                    "queue_durable":True}
        if method == "runtime.stop":
            return {"safe_to_stop":not any(c["running"] for c in self.state["conversations"].values())}
        principal = self.principal(params)
        if method in {"conversations.open", "inputs.submit", "queue.withdraw", "queue.reorder", "context.compact"}:
            if params.get("runtime_generation") != self.generation:
                raise BackendError("stale_generation", "Mutation belongs to another process generation")
        if method == "connections.list":
            return {"items":[{"id":"connection-1","revision":"r-1","display_name":"Synthetic API","state":"available"}],"next_cursor":None}
        if method == "conversations.list":
            return {"items":[{"conversation_ref":self.ref(c),"title":c["title"],"state":"idle"}
                             for c in self.state["conversations"].values() if c["principal"] == principal],
                    "next_cursor":None,"stream_id":self.state["stream_id"],"through_sequence":len(self.state["events"])}
        if method == "conversations.open":
            key, previous = self.existing(method, params)
            if previous:
                return copy.deepcopy(previous["result"])
            mode = params.get("mode", "create")
            if mode == "attach":
                matches = [c for c in self.state["conversations"].values()
                           if c["principal"] == principal and c["native_id"] == params.get("native_conversation_id")]
                if not matches:
                    raise BackendError("permission_denied", "Native conversation is outside authorized scope")
                result = {"conversation_ref":self.ref(matches[0])}
                self.state["requests"][key] = {"fingerprint":self.fingerprint(method,params),"result":result}
                self.save()
                return copy.deepcopy(result)
            if mode != "create":
                raise BackendError("invalid_request", "Conversation mode must be create or attach")
            ident = "conversation-"+uuid.uuid4().hex
            c = {"id":ident,"native_id":self.store.native_prefix+uuid.uuid4().hex,
                 "principal":principal,"title":params.get("title","Synthetic conversation"),
                 "messages":[],"queue":[],"running":None,"queue_revision":0,
                 "context":self.store.new_context(),"tool_count":0,"recovery_required":False}
            self.state["conversations"][ident] = c
            result = {"conversation_ref":self.ref(c)}
            self.state["requests"][key] = {"fingerprint":self.fingerprint(method, params),"result":result}
            self.save()
            return copy.deepcopy(result)
        if method == "events.subscribe":
            sequence = 0
            if params.get("cursor"):
                cursor = untoken(params["cursor"])
                if cursor.get("stream_id") != self.state["stream_id"] or cursor.get("principal") != principal:
                    raise BackendError("cursor_expired", "Event cursor scope does not match")
                sequence = cursor["sequence"]
            if type(sequence) is not int or not 0 <= sequence <= len(self.state["events"]):
                raise BackendError("cursor_expired", "Event sequence is outside retained stream")
            end = min(len(self.state["events"]), sequence+100)
            events = [e for e in self.state["events"][sequence:end]
                      if self.state["conversations"][e["conversation_ref"]["conversation_id"]]["principal"] == principal]
            self.subscriber = (principal, end)
            return {"items":copy.deepcopy(events),"cursor":token({"stream_id":self.state["stream_id"],"sequence":end,"principal":principal}),
                    "has_more":end < len(self.state["events"])}
        c = self.conversation(params)
        if method == "inputs.submit":
            key, previous = self.existing(method, params)
            if previous:
                return copy.deepcopy(previous["result"])
            text = "".join(part["text"] for part in params["input"]["parts"] if part["type"] == "text")
            receipt = {"request_id":params["request_id"],"accepted":True,"durable":True,
                       "native_input_id":self.store.native_prefix+"input/"+uuid.uuid4().hex,
                       "native_run_id":None,"execution_state":"queued","receipt_id":"receipt-"+uuid.uuid4().hex,
                       "queue_revision":"q-"+str(c["queue_revision"]+1)}
            self.state["requests"][key] = {"fingerprint":self.fingerprint(method, params),
                                          "conversation_id":c["id"],"result":receipt,"text":text,
                                          "connection_ref":copy.deepcopy(params["connection_ref"])}
            c["queue"].append(key)
            c["queue_revision"] += 1
            message = {"id":receipt["native_input_id"],"revision":1,"order":len(c["messages"])+1,
                       "role":"user","phase":"final","request_id":receipt["request_id"],
                       "native_input_id":receipt["native_input_id"],"native_run_id":None,"text":text}
            c["messages"].append(message)
            self.emit(c,"input.accepted",{"execution_state":"queued","durable":True,"receipt_id":receipt["receipt_id"]},receipt)
            self.emit(c,"message.committed",{"message":message},receipt)
            self.save()
            acknowledged = copy.deepcopy(receipt)
            self.spawn(self.push_events())
            self.kick(c)
            if self.ack_delay:
                await asyncio.sleep(self.ack_delay)
            return acknowledged
        if method == "inputs.lookup":
            record = self.state["requests"].get(token([principal, params["request_id"]]))
            if not record:
                return {"status":"absent_confirmed","through_sequence":len(self.state["events"])}
            if record.get("conversation_id") != c["id"]:
                raise BackendError("permission_denied", "Input belongs to another conversation")
            return {"status":"accepted","receipt":copy.deepcopy(record["result"])}
        if method == "history.read":
            if sum(key in params for key in ("tail","before","after")) > 1:
                raise BackendError("invalid_request", "History direction must be exclusive")
            limit = params.get("limit", params.get("tail", 10))
            if type(limit) is not int or not 1 <= limit <= 100:
                raise BackendError("invalid_request", "History limit is outside allowed range")
            messages = c["messages"]
            cursor = params.get("before", params.get("after"))
            pivot = None
            if cursor:
                decoded = untoken(cursor)
                if decoded.get("conversation_id") != c["id"] or decoded.get("instance_id") != self.instance_id:
                    raise BackendError("cursor_expired", "History cursor belongs to another conversation")
                pivot = decoded["order"]
            selected = ([m for m in messages if m["order"] < pivot][-limit:] if "before" in params else
                        [m for m in messages if m["order"] > pivot][:limit] if "after" in params else messages[-limit:])
            def cursor_at(message):
                return token({"conversation_id":c["id"],"instance_id":self.instance_id,"order":message["order"]})
            return {"items":copy.deepcopy(selected), "before_cursor":cursor_at(selected[0]) if selected else None,
                    "after_cursor":cursor_at(selected[-1]) if selected else None,
                    "stream_id":self.state["stream_id"],"through_sequence":len(self.state["events"])}
        if method == "state.snapshot":
            return {"conversation_ref":self.ref(c),"stream_id":self.state["stream_id"],
                    "through_sequence":len(self.state["events"]),"queue_revision":"q-"+str(c["queue_revision"]),
                    "state":"recovery_required" if c["recovery_required"] else "running" if c["running"] else "idle"}
        if method == "queue.snapshot":
            return {"revision":"q-"+str(c["queue_revision"]),
                    "items":[copy.deepcopy(self.state["requests"][key]["result"]) for key in c["queue"]]}
        if method in ("queue.withdraw", "queue.reorder"):
            if params["expected_revision"] != "q-"+str(c["queue_revision"]):
                raise BackendError("revision_conflict", "Queue revision changed")
            if method == "queue.withdraw":
                matches = [key for key in c["queue"] if self.state["requests"][key]["result"]["native_input_id"] == params["native_input_id"]]
                if not matches:
                    raise BackendError("already_started", "Input is not pending in this queue")
                c["queue"].remove(matches[0])
                self.state["requests"][matches[0]]["result"]["execution_state"] = "withdrawn"
            else:
                index = {self.state["requests"][key]["result"]["native_input_id"]:key for key in c["queue"]}
                order = params["native_input_ids"]
                if len(order) != len(index) or set(order) != set(index):
                    raise BackendError("invalid_request", "Reorder must preserve precisely the pending items")
                c["queue"] = [index[i] for i in order]
            c["queue_revision"] += 1
            self.save()
            return {"revision":"q-"+str(c["queue_revision"])}
        if method == "context.inspect":
            return {"owner":"backend","source":"synthetic_fixture","compactions":c.get("compactions",0),
                    "history_messages":len(c["messages"])}
        if method == "context.compact":
            self.store.compact(c["context"])
            c["compactions"] = c.get("compactions",0)+1
            self.emit(c,"context.compacted",{"owner":"backend"})
            self.save()
            return {"status":"completed"}
        if method == "usage.read":
            return {"source":"not_reported","input_tokens":None,"output_tokens":None,"cost":None}
        raise BackendError("unsupported_capability", "Operation is not supported")


class StdinReader:
    async def read(self, size):
        return await asyncio.to_thread(sys.stdin.buffer.read1, size)


class StdoutWriter:
    def write(self, data):
        sys.stdout.buffer.write(data)

    async def drain(self):
        sys.stdout.buffer.flush()

    def close(self):
        pass


async def run(store_type, args):
    root = Path(args.data_root)
    root.mkdir(parents=True, exist_ok=True)
    fixture = BackendFixture(store_type(root), args.instance_id, args.generation)
    peer = RpcPeer(StdinReader(), StdoutWriter(), direction="b", handler=fixture.handle).start()
    fixture.peer = peer
    await peer._reader_task
    await peer.close()
    for task in fixture.tasks:
        task.cancel()
    await asyncio.gather(*fixture.tasks, return_exceptions=True)


def serve(store_type):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-root", required=True)
    parser.add_argument("--instance-id", required=True)
    parser.add_argument("--generation", required=True)
    asyncio.run(run(store_type, parser.parse_args()))
