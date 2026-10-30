"""R2-02 checkpoint: CLI discovery and native generation are separate real HTTP operations."""
import json
from pathlib import Path
import subprocess
import tempfile

from tools.native_api_smoke import native_server, synthetic_model
from tools.native_baseline import ROOT, environment, provenance
from tools.native_conversation_smoke import wait_for


def smoke():
    parent = ROOT / "runtime/baseline/provider-discovery"
    parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=parent) as temporary, synthetic_model() as (config, generated):
        home = Path(temporary)
        connection = config["providers"]["baseline"]["settings"]
        env = environment("provider-discovery")
        env["IM_ASSISTANT_DATA_ROOT"] = str(home)
        command = [str(ROOT / provenance()["runtime"]["bun"]), "run", "src/cli.ts", "models"]
        result = subprocess.run(command, cwd=ROOT / "opencode/packages/im-assistant", env=env,
            input=json.dumps({"baseURL": connection["baseURL"], "apiKey": connection["apiKey"]}),
            capture_output=True, text=True, encoding="utf-8", timeout=30,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        assert result.returncode == 0, "Discovery CLI failed"
        discovered = json.loads(result.stdout)
        assert discovered == {"models": ["baseline"], "generationVerified": False}
        assert generated == [], "Catalog discovery must not invoke generation"
        assert connection["apiKey"] not in result.stdout + result.stderr
        with native_server(home, config, managed=True) as (request, _):
            catalog = request("GET", "/api/model")
            assert "baseline" in json.dumps(catalog)
            session = request("POST", "/api/session", {"title": "API generation checkpoint",
                "location": {"directory": str(home / "session-location")},
                "model": {"providerID": "baseline", "id": discovered["models"][0]}})["data"]
            endpoint = "/api/session/" + session["id"]
            request("POST", endpoint + "/prompt", {"text": "Verify generation separately from catalog discovery"})
            wait_for(lambda: request("GET", endpoint)["data"].get("outcome") == "succeeded", "Native API did not complete")
            messages = request("GET", endpoint + "/message?limit=20&order=asc")["data"]
            answer = next(item for item in messages if item["type"] == "assistant")
            assert answer["tokens"]["input"] == 10 and answer["tokens"]["output"] == 4
            assert answer["content"] == [{"type": "text", "text": "Native baseline reply"}]
            assert len(generated) == 1
        return {"catalog_cli_real_http": True, "generation_verified_separately": True,
            "native_reported_usage_persisted": True, "discovery_changes_default_or_queue": False,
            "external_model_requests": 0, "R2_02_complete": False}


if __name__ == "__main__":
    result = smoke()
    (ROOT / ".reports/native/r2-02-provider-checkpoint.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))
