"""Actual product policy through native HTTP, queue, generation and SQLite persistence."""
import base64
import json
from pathlib import Path
import tempfile
import time
import uuid
import sys
import urllib.request
from urllib.parse import quote
from tools.native_baseline import ROOT
from tools.native_api_smoke import native_server, synthetic_model


def policy_smoke():
    parent = ROOT / "runtime/baseline/policy-smoke"
    parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="run-", dir=parent) as temporary, synthetic_model() as (config, received):
        home = Path(temporary)
        sentinel = home / "outside-project.txt"
        sentinel.write_text("Outside project sentinel: never load into a model", encoding="utf-8")
        marker = home / "untrusted-integration-ran.txt"
        plugin = home / "untrusted-plugin.ts"
        plugin.write_text("import { writeFileSync } from 'node:fs';\nwriteFileSync(" + json.dumps(str(marker)) + ", 'bad');\nexport default {};\n", encoding="utf-8")
        config.update({"plugins": [plugin.as_uri()], "instructions": [str(sentinel)],
            "agents": {"build": {"system": "Reference: {file:" + str(sentinel) + "}"}},
            "mcp": {"servers": {"untrusted": {"type": "local", "command": [sys.executable, "-c",
                "from pathlib import Path; Path(" + repr(str(marker)) + ").write_text('bad')"]}}}})
        config["providers"]["baseline"]["models"]["baseline"]["capabilities"]["tools"] = True
        config["providers"]["baseline"]["models"]["baseline"]["capabilities"]["input"] = ["text", "image"]
        with native_server(home, config, managed=True) as (request, info):
            assert info["capabilities"]["experimental"]["projectWorkspace"] is False
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(info["urls"][0] + "/new-session", timeout=15) as response:
                shell = response.read().decode("utf-8")
            assert '<meta name="opencode-workspace" content="disabled">' in shell
            location = {"directory": str(home / "session-location")}
            session = request("POST", "/api/session", {"title": "Managed policy probe", "location": location,
                "model": {"providerID": "baseline", "id": "baseline"}})["data"]
            endpoint = "/api/session/" + session["id"]
            denied = [
                ("GET", "/api/fs/list?path=" + quote(str(home))),
                ("GET", "/api/fs/read/" + quote(sentinel.as_posix())),
                ("GET", "/api/fs/find?query=sentinel"),
                ("POST", "/api/experimental/fs/write", {"path": str(sentinel), "content": "bad"}),
                ("POST", endpoint + "/shell", {"command": "echo forbidden"}),
                ("POST", endpoint + "/command", {"command": "forbidden"}),
                ("POST", "/api/pty", {}),
                ("POST", "/api/shell", {}),
                ("POST", "/api/rpc/experimental.browser/run", {}),
                ("PUT", "/api/experimental/mcp/test", {}),
                ("POST", "/api/integration/test/connect/command", {}),
                ("POST", "/api/worktree", {}),
                ("POST", "/api/vcs/init", {}),
                ("GET", "/api/plugin/gui"),
                ("POST", "/api/plugin/update", {}),
            ]
            for method, path, *body in denied:
                try:
                    request(method, path, body[0] if body else None)
                except RuntimeError as error:
                    assert ": 403:" in str(error) and "runtime_capability_disabled" in str(error), str(error)
                else:
                    raise AssertionError("Forbidden API accepted: " + method + " " + path)
            for method, path, payload in [
                ("POST", "/api/session", {"location": {"directory": str(home)}}),
                ("POST", endpoint + "/prompt", {"text": "bad file", "files": [{"uri": sentinel.as_uri()}], "resume": False}),
            ]:
                try:
                    request(method, path, payload)
                except RuntimeError:
                    pass
                else:
                    raise AssertionError("Forbidden location or file path accepted")
            assert request("GET", endpoint + "/inbox")["data"] == []
            assert request("GET", "/api/command")["data"] == []
            pending = request("POST", endpoint + "/prompt", {"text": "queued", "resume": False})["data"]
            assert request("GET", endpoint + "/inbox")["data"] == [pending]
            request("DELETE", endpoint + "/inbox/" + pending["id"])
            png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII="
            request("POST", endpoint + "/prompt", {"text": "Read my uploaded attachment", "files": [{
                "uri": "data:text/plain;base64," + base64.b64encode(b"controlled attachment bytes").decode(),
                "name": "note.txt"}, {"uri": "data:image/png;base64," + png, "name": "pixel.png"}]})
            deadline = time.monotonic() + 40
            while request("GET", endpoint)["data"].get("outcome") != "succeeded":
                if time.monotonic() > deadline:
                    raise AssertionError("Native generation failed: " + json.dumps(request("GET", endpoint + "/message")))
                time.sleep(.1)
            history = request("GET", endpoint + "/message?limit=10&order=asc")["data"]
            assert "Native baseline reply" in json.dumps(history)
            assert any(m.get("files", [{}])[0].get("data") == base64.b64encode(b"controlled attachment bytes").decode()
                       for m in history if m.get("files")), history
            assert any(file.get("mime", "").startswith("image/") and file.get("data")
                       for message in history for file in message.get("files", []))
            assert received and all(not call.get("tools") for call in received), "Model received disallowed tools"
            assert all("Outside project sentinel" not in json.dumps(call) for call in received)
            exported = request("GET", "/api/experimental/session/" + session["id"] + "/export")
            serialized = json.dumps(exported["data"]).replace(session["id"], "ses_" + uuid.uuid4().hex)
            for message in exported["data"]["messages"]:
                serialized = serialized.replace(message["id"], "msg_" + uuid.uuid4().hex)
            imported = request("POST", "/api/experimental/session/import", {**json.loads(serialized), "location": location})
            imported_history = request("GET", "/api/session/" + imported["data"]["id"] + "/message?limit=10")["data"]
            assert len(imported_history) == len(history)
        with native_server(home, config, managed=True) as (request, _):
            assert request("GET", endpoint + "/message?limit=10&order=asc")["data"] == history
            assert request("GET", endpoint + "/inbox")["data"] == []
        assert sentinel.read_text(encoding="utf-8").startswith("Outside project sentinel")
        assert not marker.exists(), "Configured external plugin or MCP executed"
        return {"denied_direct_apis": len(denied), "local_attachment_rejected": True,
                "external_location_rejected": True, "native_queue_withdrawal": True,
                "byte_attachment_preserved": True, "native_import_export_and_restart": True,
                "model_tool_catalog_empty": True, "configured_plugin_and_mcp_blocked": True,
                "ambient_instructions_and_file_substitution_disabled": True, "external_model_calls": 0}


if __name__ == "__main__":
    print(json.dumps(policy_smoke(), indent=2))
