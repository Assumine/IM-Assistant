"""Configure real native providers/credentials over HTTP, with only the upstream model stubbed."""
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import secrets
import tempfile
import threading

from tools.native_api_smoke import native_server
from tools.native_baseline import ROOT
from tools.native_conversation_smoke import wait_for


@contextmanager
def authenticated_model():
    key = secrets.token_urlsafe(32)
    received = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            valid = self.headers.get("Authorization") == "Bearer " + key
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            received.append({"authenticated": valid, "model": body.get("model")})
            if not valid:
                self.send_error(401)
                return
            chunks = [
                {"choices": [{"index": 0, "delta": {"role": "assistant", "content": "Configured API reply"}, "finish_reason": None}]},
                {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                 "usage": {"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14}},
            ]
            raw = ("".join("data: " + json.dumps({"id": "configured", "object": "chat.completion.chunk",
                "model": body["model"], "created": 0, **chunk}) + "\n\n" for chunk in chunks) + "data: [DONE]\n\n").encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield {"id": "private-api", "name": "Private API fixture", "baseURL": f"http://127.0.0.1:{server.server_port}/v1",
            "models": [{"id": "configured-model", "context": 32000, "output": 1024}]}, key, received
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def smoke():
    parent = ROOT / "runtime/baseline/provider-configuration"
    parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=parent) as temporary, authenticated_model() as (connection, key, received):
        home = Path(temporary)
        config = home / "config/opencode.json"
        config.parent.mkdir(parents=True)
        config.write_text('// Preserve private settings\n{"update":"disable","share":"disabled"}\n', encoding="utf-8")
        with native_server(home, managed=True) as (request, _):
            # Prime the existing native location before adding connections.
            request("GET", "/api/model")
            existing = request("GET", "/api/provider")["data"]
            assert existing, "The native provider catalog was not initialized"
            reserved = existing[0]["id"]
            request("POST", "/api/experimental/config/provider", connection)
            integration = "/api/integration/" + connection["id"]
            wait_for(lambda: connection["id"] in json.dumps(request("GET", "/api/integration")), "New API integration missing")
            request("POST", integration + "/connect/key", {"key": key, "label": "Fixture credential"})
            wait_for(lambda: connection["id"] in json.dumps(request("GET", "/api/model")), "New API model missing")
            selected = {"providerID": connection["id"], "id": "configured-model"}
            session = request("POST", "/api/session", {"title": "Native connection persistence",
                "location": {"directory": str(home / "session-location")}, "model": selected})["data"]
            endpoint = "/api/session/" + session["id"]
            pinned = request("GET", endpoint)["data"]["model"]
            assert pinned["providerID"] == selected["providerID"] and pinned["id"] == selected["id"]
            admitted = request("POST", endpoint + "/prompt", {"text": "Preserve this queued input", "resume": False})["data"]
            # A second connection must not change the existing session or pending input.
            request("POST", "/api/experimental/config/provider", {**connection, "id": "second-api", "name": "Second API"})
            assert request("GET", endpoint)["data"]["model"] == pinned
            assert request("GET", endpoint + "/inbox")["data"] == [admitted]
            for payload, status in [
                (connection, 409),
                ({**connection, "id": reserved}, 409),
                ({**connection, "id": "unsafe", "baseURL": "file:///private/config"}, 400),
                ({**connection, "id": "unsafe", "baseURL": "https://example.invalid/v1?key=not-a-secret"}, 400),
                ({**connection, "id": "unsafe", "models": [{"id": "m", "context": 1, "output": 2}]}, 400),
            ]:
                try:
                    request("POST", "/api/experimental/config/provider", payload)
                except RuntimeError as error:
                    assert f": {status}:" in str(error), str(error)
                else:
                    raise AssertionError("Invalid or duplicate connection accepted")
            saved = config.read_text(encoding="utf-8")
            assert key not in saved and "apiKey" not in saved
            assert saved.startswith("// Preserve private settings\n"), "Native JSONC comments were lost"
            document = json.loads("\n".join(saved.splitlines()[1:]))
            assert document["update"] == "disable" and document["share"] == "disabled"
            providers = document["providers"]
            assert set(providers) == {"private-api", "second-api"}
            assert providers["private-api"]["package"] == "@opencode/ai/providers/openai-compatible"
            credentials = request("GET", "/api/credential")["data"]
            assert len(credentials) == 1 and credentials[0]["label"] == "Fixture credential"
            assert credentials[0]["value"]["key"] == key
            # Config writes must not unlock the generic shell/project configuration surface.
            try:
                request("PATCH", "/api/experimental/config", {"shell": {"command": "unavailable"}})
            except RuntimeError as error:
                assert ": 403:" in str(error)
            else:
                raise AssertionError("Generic configuration bypass enabled")
        with native_server(home, managed=True) as (request, _):
            assert request("GET", endpoint)["data"]["model"] == pinned
            assert request("GET", endpoint + "/inbox")["data"] == [admitted]
            assert request("GET", "/api/credential")["data"] == credentials
            assert received == [], "Reading/configuring must not invoke generation"
            request("POST", endpoint + "/prompt", {"id": admitted["id"], "text": "Preserve this queued input", "resume": True})
            wait_for(lambda: request("GET", endpoint)["data"].get("outcome") == "succeeded", "Configured API generation failed")
            messages = request("GET", endpoint + "/message?limit=20&order=asc")["data"]
            assert "Configured API reply" in json.dumps(messages)
            assert received == [{"authenticated": True, "model": "configured-model"}]
            assert request("GET", endpoint + "/inbox")["data"] == []
            # Public catalogs expose connection state, not the saved key.
            assert key not in json.dumps([request("GET", "/api/config"), request("GET", "/api/integration"), request("GET", "/api/model")])
        for log in home.glob("server-*.log"):
            assert key not in log.read_text(encoding="utf-8", errors="replace"), "Credential leaked to native server output"
        return {"native_configuration_http": True, "native_credentials_sqlite": True,
            "restart_preserves_connections_and_credentials": True, "pending_input_and_model_unchanged": True,
            "generation_uses_saved_key": True, "duplicate_and_builtin_id_conflict": True, "unsafe_configuration_rejected": True,
            "generic_config_remains_denied": True, "external_model_requests": 0, "R2_02_complete": False}


if __name__ == "__main__":
    result = smoke()
    (ROOT / ".reports/native/r2-02-configuration-checkpoint.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))
