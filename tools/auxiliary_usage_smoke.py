"""Verify native auxiliary accounting with selective persistence and a real local model connection."""
import json
from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile

from tools.native_api_smoke import native_server, synthetic_model
from tools.native_baseline import ROOT
from tools.native_conversation_smoke import wait_for


def accounting(home):
    database = home / "native.db"
    assert database.is_file()
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as db:
        return [{"type": row[0], "created": row[1], "data": json.loads(row[2])}
                for row in db.execute('SELECT type, created, data FROM event ORDER BY created, seq')]


def smoke():
    parent = ROOT / "runtime/baseline/auxiliary-usage"
    parent.mkdir(parents=True, exist_ok=True)
    def reply(request):
        if "You MUST use this format" in json.dumps(request):
            return "## Objective\n- Verify isolated native accounting and context compaction."
        return "Native baseline reply"

    with tempfile.TemporaryDirectory(dir=parent) as temporary, synthetic_model(reply) as (config, generated):
        home = Path(temporary)
        config["compaction"] = {"auto": False, "keep": {"tokens": 0}, "buffer": 0}
        with native_server(home, config, managed=True) as (request, _):
            catalog = request("GET", "/api/model")["data"]
            model = next(item for item in catalog if item["providerID"] == "baseline" and item["id"] == "baseline")
            assert model["limit"]["context"] == 32000 and model["limit"]["output"] == 1024
            session = request("POST", "/api/session", {
                "location": {"directory": str(home / "session-location")},
                "model": {"providerID": "baseline", "id": "baseline"}})["data"]
            endpoint = "/api/session/" + session["id"]
            request("POST", endpoint + "/prompt", {"text": "Summarize the purpose of this isolated accounting check"})
            wait_for(lambda: request("GET", endpoint)["data"].get("outcome") == "succeeded", "Native conversation did not settle")
            wait_for(lambda: any(row["data"]["source"] == "title" for row in accounting(home)), "Native title accounting missing")
            before = request("GET", endpoint + "/message?limit=20&order=asc")["data"]
            transient = request("POST", endpoint + "/generate", {"prompt": "Give a private one-line summary"})
            assert transient["data"]["text"] == "Native baseline reply"
            assert request("GET", endpoint + "/message?limit=20&order=asc")["data"] == before
            request("POST", endpoint + "/compact", {})
            wait_for(lambda: any(row["data"]["source"] == "compaction" for row in accounting(home)), "Native compaction accounting missing")
            wait_for(lambda: request("GET", endpoint + "/inbox")["data"] == [], "Native compaction input stayed pending")
            wait_for(lambda: any(item["type"] == "compaction" and item["status"] == "completed"
                for item in request("GET", endpoint + "/message?limit=20")["data"]), "Native compaction did not complete")
            context = request("GET", endpoint + "/context")["data"]
            assert any(item["type"] == "compaction" and item["status"] == "completed" for item in context)
            assert not {item["id"] for item in before}.intersection(item["id"] for item in context), "Compacted messages stayed in the active model context"
            rows = accounting(home)
            assert {row["type"] for row in rows} == {"session.usage.recorded.1"}, "Full conversation event retention was enabled"
            assert {row["data"]["source"] for row in rows} == {"title", "generate", "compaction"}
            assert all(row["data"]["model"]["providerID"] == "baseline" for row in rows)
            messages = request("GET", endpoint + "/message?limit=20&order=asc")["data"]
            assistants = [item for item in messages if item["type"] == "assistant"]
            assert len(assistants) == 1, "Auxiliary usage appeared as a duplicate chat reply"
            cutoff = max(row["created"] for row in rows) + 1
            stats_endpoint = f"/api/experimental/session/stats?tools=none&to={cutoff}"
            stats = request("GET", stats_endpoint)["data"]
            calls = len(rows) + len(assistants)
            assert stats["tokens"]["input"] == calls * 10 and stats["tokens"]["output"] == calls * 4
            assert stats["reporting"]["records"] == calls and stats["steps"] == 1
            assert len(generated) == calls, "An executed model call was not accounted for"
            assert len(stats["models"]) == 1 and stats["models"][0]["tokens"] == stats["tokens"]
        with native_server(home, config, managed=True) as (request, _):
            assert request("GET", stats_endpoint)["data"] == stats, "Restart changed native usage totals or attribution"
            assert request("GET", endpoint + "/context")["data"] == context
            assert accounting(home) == rows
            assert len(generated) == calls, "Stats reads re-executed a model request"
        return {"real_native_http_sqlite": True, "selective_accounting_retention": True,
            "sources": ["title", "generate", "compaction"], "model_requests_accounted": calls,
            "generation_preserves_transcript": True, "no_auxiliary_double_count": True,
            "native_context_limits": {"context": 32000, "output": 1024}, "native_compacted_context_restored": True,
            "restart_preserves_totals_and_model_attribution": True, "external_model_requests": 0}


if __name__ == "__main__":
    result = smoke()
    (ROOT / ".reports/native/r2-02-auxiliary-checkpoint.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))
