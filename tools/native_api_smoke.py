"""Exercise the original HTTP/SQLite/Inbox implementation, never a replacement host."""

import base64
from contextlib import contextmanager
import json
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from tools.native_baseline import ROOT, environment, provenance


@contextmanager
def native_server(home, config=None, *, managed=False):
    """Only terminate the foreground child owned by this context, never a shared service."""
    with socket.socket() as reserved:
        reserved.bind(("127.0.0.1", 0))
        port = reserved.getsockname()[1]
    password = secrets.token_urlsafe(32)
    env = environment("api-smoke")
    env.update({
        "HOME": str(home), "USERPROFILE": str(home),
        "XDG_CONFIG_HOME": str(home / "config"), "XDG_DATA_HOME": str(home / "data"),
        "XDG_CACHE_HOME": str(home / "cache"), "XDG_STATE_HOME": str(home / "state"),
        "OPENCODE_TEST_HOME": str(home), "OPENCODE_CONFIG_DIR": str(home / "config"),
        "OPENCODE_DB": str(home / "native.db"), "OPENCODE_PASSWORD": password,
        "OPENCODE_CONFIG_CONTENT": json.dumps(config or {"update": "disable", "share": "disabled"}),
        "OPENCODE_DISABLE_FILEWATCHER": "true", "OPENCODE_DISABLE_PROJECT_CONFIG": "true",
    })
    if managed:
        (home / "session-location").mkdir(exist_ok=True)
        env.update({"IM_ASSISTANT_PROFILE": "personal", "IM_ASSISTANT_DATA_ROOT": str(home)})
    log = home / f"server-{port}.log"
    with log.open("wb") as output:
        process = subprocess.Popen(
            [str(ROOT / provenance()["runtime"]["bun"]), "run", "src/index.ts", "serve",
             "--hostname", "127.0.0.1", "--port", str(port)],
            cwd=ROOT / "opencode/packages/cli", env=env,
            stdout=output, stderr=subprocess.STDOUT,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        authorization = "Basic " + base64.b64encode(("opencode:" + password).encode()).decode()

        def request(method, path, payload=None):
            body = None if payload is None else json.dumps(payload).encode()
            req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=body, method=method,
                headers={"Authorization": authorization, "Content-Type": "application/json"})
            try:
                with opener.open(req, timeout=15) as response:
                    raw = response.read()
                    return json.loads(raw) if raw else None
            except urllib.error.HTTPError as error:
                raise RuntimeError(f"Native API {method} {path}: {error.code}: "
                                   + error.read().decode(errors="replace")[:2000]) from None

        try:
            deadline = time.monotonic() + 60
            while True:
                if process.poll() is not None:
                    raise RuntimeError(f"Native server exited: {log.read_text(errors='replace')[-4000:]}")
                try:
                    info = request("GET", "/api/info")
                    break
                except (OSError, RuntimeError):
                    if time.monotonic() > deadline:
                        raise RuntimeError(f"Native server not ready: {log}") from None
                    time.sleep(.1)
            assert info["pid"] == process.pid, "Connected to a server not owned by this test"
            yield request, info
        finally:
            if process.poll() is None:
                process.terminate()
            process.wait(timeout=15)


def inbox_restart_smoke():
    parent = ROOT / "runtime/baseline/api-smoke"
    parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="run-", dir=parent) as directory:
        home = Path(directory)
        workspace = home / "empty-project"
        workspace.mkdir()
        with native_server(home) as (request, info):
            session = request("POST", "/api/session", {
                "title": "Isolated native baseline", "location": {"directory": str(workspace)}})["data"]
            endpoint = "/api/session/" + session["id"]
            admitted = [request("POST", endpoint + "/prompt", {
                "text": text, "delivery": "queue", "resume": False})["data"]
                for text in ("First native input", "Second native input", "Withdraw this input")]
            inbox = request("GET", endpoint + "/inbox")["data"]
            assert [item["id"] for item in inbox] == [item["id"] for item in admitted], inbox
            duplicate = request("POST", endpoint + "/prompt", {
                "id": admitted[0]["id"], "text": "Changed duplicate", "resume": False})["data"]
            assert duplicate == admitted[0], "Native first admission must remain authoritative"
            request("DELETE", endpoint + "/inbox/" + admitted[2]["id"])
            before = request("GET", endpoint + "/inbox")["data"]
            assert len(before) == 2
            assert request("GET", endpoint + "/message?limit=10")["data"] == [], "Pending input isn't history"
        with native_server(home) as (request, recovered_info):
            restored = request("GET", endpoint)["data"]
            after = request("GET", endpoint + "/inbox")["data"]
            assert restored["id"] == session["id"]
            assert after == before, "Restart lost or reordered native Inbox"
            assert recovered_info["pid"] != info["pid"]
            for item in after:
                request("DELETE", endpoint + "/inbox/" + item["id"])
            assert request("GET", endpoint + "/inbox")["data"] == []
        return {"real_native_http": True, "isolated_sqlite": True, "restart_preserves_inbox": True,
                "admission_count": 3, "duplicate_first_wins": True, "withdrawal_preserved": True,
                "external_model_requests": 0}


@contextmanager
def synthetic_model():
    """Only model tokens are synthetic; all application admission/history/database code is original."""
    received = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            received.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
            chunks = [
                {"choices": [{"index": 0, "delta": {"role": "assistant", "content": "Native baseline reply"},
                              "finish_reason": None}]},
                {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                 "usage": {"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14}},
            ]
            content = "".join("data: " + json.dumps({"id": "synthetic", "object": "chat.completion.chunk",
                               "model": "baseline", "created": 0, **chunk}) + "\n\n" for chunk in chunks)
            data = (content + "data: [DONE]\n\n").encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    config = {"model": "baseline/baseline", "update": "disable", "share": "disabled",
        "providers": {"baseline": {"name": "Synthetic local baseline",
            "package": "@opencode/ai/providers/openai-compatible",
            "settings": {"baseURL": f"http://127.0.0.1:{server.server_port}/v1", "apiKey": "synthetic"},
            "models": {"baseline": {"name": "Synthetic local baseline", "limit": {"context": 32000, "output": 1024},
                "capabilities": {"tools": False, "input": ["text"], "output": ["text"]}}}}}}
    try:
        yield config, received
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def history_restart_smoke():
    parent = ROOT / "runtime/baseline/api-smoke"
    parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="history-", dir=parent) as directory, synthetic_model() as (config, received):
        home = Path(directory)
        project = home / "empty-project"
        project.mkdir()
        with native_server(home, config) as (request, info):
            session = request("POST", "/api/session", {"title": "Synthetic model native history",
                "location": {"directory": str(project)}, "model": {"providerID": "baseline", "id": "baseline"}})["data"]
            endpoint = "/api/session/" + session["id"]
            admitted = request("POST", endpoint + "/prompt", {"text": "Native history persistence probe"})["data"]
            deadline = time.monotonic() + 40
            while True:
                state = request("GET", endpoint)["data"]
                if state.get("outcome") == "succeeded":
                    break
                if time.monotonic() > deadline:
                    messages = request("GET", endpoint + "/message?limit=10")
                    raise AssertionError(f"Native generation did not complete: {state}; history={messages}")
                time.sleep(.1)
            before = request("GET", endpoint + "/message?limit=10&order=asc")["data"]
            assert len(before) >= 2, before
            assert "Native baseline reply" in json.dumps(before), before
            assert received, "Native runtime did not call the local model fixture"
            assert request("GET", endpoint + "/inbox")["data"] == []
        with native_server(home, config) as (request, info):
            after = request("GET", endpoint + "/message?limit=10&order=asc")["data"]
            assert after == before, "Restart changed original persisted history"
            assert request("GET", endpoint + "/inbox")["data"] == []
            first_page = request("GET", endpoint + "/message?limit=1&order=asc")
            assert len(first_page["data"]) == 1
        return {"real_native_http": True, "real_native_history": True, "restart_preserves_history": True,
                "model_fixture": "synthetic local OpenAI-compatible HTTP", "synthetic_model_requests": len(received),
                "persisted_messages": len(before), "external_model_requests": 0}


if __name__ == "__main__":
    print(json.dumps({"inbox": inbox_restart_smoke(), "history": history_restart_smoke()}, indent=2))
