"""Control only the model stream; admission, delivery, events and SQLite are native."""

from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading
import time

from tools.native_api_smoke import native_server
from tools.native_baseline import ROOT


class ModelStream:
    def __init__(self, body):
        self.body = body
        self.release = threading.Event()


@contextmanager
def controlled_model():
    calls = []
    changed = threading.Condition()
    stopping = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            call = ModelStream(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
            with changed:
                calls.append(call)
                index = len(calls)
                changed.notify_all()
            # No first token is sent until the test explicitly releases this request.
            if not call.release.wait(60) or stopping.is_set():
                return
            chunks = [
                {"choices": [{"index": 0, "delta": {"role": "assistant", "content": f"Response {index}"},
                              "finish_reason": None}]},
                {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                 "usage": {"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14}},
            ]
            data = ("".join("data: " + json.dumps({"id": f"local-{index}", "object": "chat.completion.chunk",
                "model": "baseline", "created": 0, **chunk}) + "\n\n" for chunk in chunks)
                + "data: [DONE]\n\n").encode()
            try:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    def reached(count):
        with changed:
            assert changed.wait_for(lambda: len(calls) >= count, timeout=40), f"Missing model request {count}"
            assert len(calls) == count, "Unexpected duplicate model execution"
            return calls[count - 1]

    config = {"model": "baseline/baseline", "update": "disable", "share": "disabled",
        "providers": {"baseline": {"name": "Controlled local conversation model",
            "package": "@opencode/ai/providers/openai-compatible",
            "settings": {"baseURL": f"http://127.0.0.1:{server.server_port}/v1", "apiKey": "synthetic"},
            "models": {"baseline": {"name": "Controlled local model", "limit": {"context": 32000, "output": 1024},
                "capabilities": {"tools": False, "input": ["text"], "output": ["text"]}}}}}}
    try:
        yield config, calls, reached
    finally:
        stopping.set()
        for call in calls:
            call.release.set()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def wait_for(check, description):
    deadline = time.monotonic() + 40
    while True:
        value = check()
        if value:
            return value
        assert time.monotonic() < deadline, description
        # Bounded polling of native HTTP state, not a simulated scheduler or browser synchronization.
        time.sleep(.05)


def conversation_smoke():
    parent = ROOT / "runtime/baseline/conversation"
    parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="run-", dir=parent) as temporary, controlled_model() as (config, calls, reached):
        home = Path(temporary)
        with native_server(home, config, managed=True) as (request, _):
            def create(title):
                return request("POST", "/api/session", {"title": title,
                    "location": {"directory": str(home / "session-location")},
                    "model": {"providerID": "baseline", "id": "baseline"}})["data"]["id"]

            first = create("First conversation")
            second = create("Second conversation")
            endpoint = "/api/session/" + first

            def send(text, delivery="queue", **options):
                return request("POST", endpoint + "/prompt", {"text": text, "delivery": delivery, **options})["data"]

            running = send("First request")
            stream1 = reached(1)
            assert first in request("GET", "/api/session/active")["data"]
            # HTTP admission and the durable queue must settle even when no AI reply exists.
            queued = send("Second request")
            withdrawn = send("Withdrawn request")
            correction = send("Correction at the next safe step", "steer")
            assert [item["id"] for item in request("GET", endpoint + "/inbox")["data"]] == [
                queued["id"], withdrawn["id"], correction["id"]]
            retry = send("Do not replace the first admission", id=queued["id"])
            assert retry == queued
            request("DELETE", endpoint + "/inbox/" + withdrawn["id"])
            assert len(calls) == 1 and not stream1.release.is_set()
            # Selecting/reading a different session is not an execution or queue ownership change.
            assert request("GET", "/api/session/" + second)["data"]["id"] == second
            assert request("GET", "/api/session/" + second + "/inbox")["data"] == []
            history = request("GET", endpoint + "/message?limit=30&order=asc")["data"]
            assert [item["text"] for item in history if item["type"] == "user"] == ["First request"]
            assert not any(item["type"] == "assistant" and item.get("content") for item in history)
            stream1.release.set()

            # A steer belongs to the same run and is consumed before a queued independent input.
            stream2 = reached(2)
            context2 = json.dumps(stream2.body["messages"])
            assert "Correction at the next safe step" in context2
            assert "Second request" not in context2 and "Withdrawn request" not in context2
            assert [item["id"] for item in request("GET", endpoint + "/inbox")["data"]] == [queued["id"]]
            stream2.release.set()
            stream3 = reached(3)
            assert "Second request" in json.dumps(stream3.body["messages"])
            assert "Withdrawn request" not in json.dumps(stream3.body["messages"])
            stream3.release.set()
            wait_for(lambda: first not in request("GET", "/api/session/active")["data"], "Native queue did not drain")
            assert request("GET", endpoint + "/inbox")["data"] == []
            before = request("GET", endpoint + "/message?limit=50&order=asc")["data"]
            users = [item for item in before if item["type"] == "user"]
            assert [item["id"] for item in users] == [running["id"], correction["id"], queued["id"]]
            assert [item["text"] for item in users] == ["First request", "Correction at the next safe step", "Second request"]

            # A native drain stays running across queued inputs; idle is emitted after the whole drain. The previous
            # assistant must finish before the next user is delivered, without injecting a synthetic idle in between.
            answers = [i for i, item in enumerate(before) if item["type"] == "assistant"]
            idle = [i for i, item in enumerate(before) if item["type"] == "idle"]
            next_input = next(i for i, item in enumerate(before) if item["id"] == queued["id"])
            assert len(answers) == 3 and len(idle) == 1, before
            assert answers[1] < next_input < answers[2] < idle[0], before
            assert before[answers[1]]["time"]["completed"] <= before[next_input]["time"]["created"]
            # A fresh idle submission starts without an external notification or viewer polling it.
            fresh = send("Fresh idle request")
            stream4 = reached(4)
            assert "Fresh idle request" in json.dumps(stream4.body["messages"])
            assert request("GET", endpoint + "/inbox")["data"] == []
            stream4.release.set()
            wait_for(lambda: first not in request("GET", "/api/session/active")["data"], "Fresh input did not finish")
            before = request("GET", endpoint + "/message?limit=50&order=asc")["data"]
            assert [item["id"] for item in before if item["type"] == "user"][-1] == fresh["id"]
        with native_server(home, config, managed=True) as (request, _):
            after = request("GET", endpoint + "/message?limit=50&order=asc")["data"]
            assert after == before, "Reconnect reordered or lost native history"
            assert request("GET", endpoint + "/inbox")["data"] == []
            assert request("GET", "/api/session/active")["data"] == {}
            assert len(calls) == 4, "Restart repeated completed work"
        return {"real_native_http_and_sqlite": True, "model_requests": len(calls), "external_model_requests": 0,
            "admission_before_first_token": True, "same_id_first_admission_wins": True,
            "steer_before_queue_at_safe_step": True, "withdrawal_not_executed": True,
            "final_step_then_next_delivery_then_drain_idle": True, "idle_input_starts_without_notification": True,
            "session_selection_does_not_own_execution": True, "restart_preserves_order_without_reexecution": True}


if __name__ == "__main__":
    result = conversation_smoke()
    (ROOT / ".reports/native/conversation-smoke.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))
