"""Release rehearsals through original HTTP/Inbox/SQLite, with disposable profiles only.

This is a test driver, not an importer for the old client or a second task router.
Only the model stream and deliberate death of our own subprocess are controlled.
"""

from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import signal
import tempfile

from tools.native_api_smoke import native_server
from tools.native_baseline import ROOT
from tools.native_conversation_smoke import controlled_model, wait_for


def create(request, home, title):
    return request("POST", "/api/session", {"title": title,
        "location": {"directory": str(home / "session-location")},
        "model": {"providerID": "baseline", "id": "baseline"}})["data"]["id"]


def history(request, session):
    return request("GET", "/api/session/" + session + "/message?limit=100&order=asc")["data"]


def send(request, session, text, **options):
    return request("POST", "/api/session/" + session + "/prompt", {"text": text, "delivery": "queue", **options})["data"]


def settled(request, session):
    wait_for(lambda: session not in request("GET", "/api/session/active")["data"], "Native execution did not settle")
    assert request("GET", "/api/session/" + session + "/inbox")["data"] == []


def migration_smoke():
    parent = ROOT / "runtime/baseline"
    with tempfile.TemporaryDirectory(prefix="release-migration-", dir=parent) as temporary, controlled_model() as (config, calls, reached):
        base = Path(temporary)
        source, destination = base / "source", base / "destination"
        source.mkdir()
        destination.mkdir()
        with ExitStack() as stack:
            old, _ = stack.enter_context(native_server(source, config, managed=True))
            new, _ = stack.enter_context(native_server(destination, config, managed=True))
            session = create(old, source, "Synthetic migration rehearsal")
            first = send(old, session, "A accepted by source before handover")
            one = reached(1)
            second = send(old, session, "B queued at source before handover")
            # Handover first drains the accepting owner. Pending work is never exported as executable work.
            assert old("GET", "/api/session/" + session + "/inbox")["data"] == [second]
            one.release.set()
            reached(2).release.set()
            settled(old, session)
            original = history(old, session)
            snapshot = old("GET", "/api/experimental/session/" + session + "/export")["data"]
            receipt = new("POST", "/api/experimental/session/import", {
                **snapshot, "location": {"directory": str(destination / "session-location")}})["data"]
            assert receipt["id"] == session
            assert history(new, session) == original
            assert new("GET", "/api/session/active")["data"] == {}
            assert new("GET", "/api/session/" + session + "/inbox")["data"] == []
            try:
                new("POST", "/api/experimental/session/import", {
                    **snapshot, "location": {"directory": str(destination / "session-location")}})
            except RuntimeError as error:
                assert ": 409:" in str(error), str(error)
            else:
                raise AssertionError("Native import overwrote an existing session")
            assert len(calls) == 2, "History import replayed accepted work"
            third = send(new, session, "C accepted only by destination after handover")
            reached(3).release.set()
            settled(new, session)
            # Rollback changes the owner for *new* input; C is not copied back or replayed.
            fourth = send(old, session, "D accepted only by source after rollback")
            reached(4).release.set()
            settled(old, session)
            before_old, before_new = history(old, session), history(new, session)
            assert [item["id"] for item in before_old if item["type"] == "user"] == [first["id"], second["id"], fourth["id"]]
            assert [item["id"] for item in before_new if item["type"] == "user"] == [first["id"], second["id"], third["id"]]
        with ExitStack() as stack:
            old, _ = stack.enter_context(native_server(source, config, managed=True))
            new, _ = stack.enter_context(native_server(destination, config, managed=True))
            assert history(old, session) == before_old and history(new, session) == before_new
            assert old("GET", "/api/session/active")["data"] == {} and new("GET", "/api/session/active")["data"] == {}
            assert len(calls) == 4, "Restart replayed a delivered input"
        manifest = {"synthetic_only": True, "session_id": session, "inputs": [
            {"input_id": item["id"], "accepting_owner": owner}
            for item, owner in [(first, "source"), (second, "source"), (third, "destination"), (fourth, "source")]],
            "snapshot_sha256": hashlib.sha256(json.dumps(snapshot, sort_keys=True).encode()).hexdigest()}
        path = ROOT / ".reports/native/r5-migration-manifest.json"
        path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        return {"native_http_sqlite": True, "synthetic_profiles": 2, "model_requests": 4,
            "accepting_owners": ["source", "source", "destination", "source"],
            "drain_before_handover": True, "import_does_not_replay": True,
            "duplicate_import_conflicts_without_overwrite": True, "rollback_routes_only_new_input": True,
            "both_histories_survive_restart": True, "local_manifest": path.relative_to(ROOT).as_posix(),
            "production_databases_touched": 0, "old_client_imported": False}


def crash_smoke():
    parent = ROOT / "runtime/baseline"
    with tempfile.TemporaryDirectory(prefix="release-crash-", dir=parent) as temporary, controlled_model() as (config, calls, reached):
        home = Path(temporary)
        with native_server(home, config, managed=True) as (request, info):
            session = create(request, home, "Synthetic crash rehearsal")
            first = send(request, session, "A completed before owned process death")
            reached(1).release.set()
            settled(request, session)
            before = history(request, session)
            queued = send(request, session, "B durably parked before process death", resume=False)
            # native_server proved this PID belongs to the exact foreground child of this test.
            # TerminateProcess on Windows bypasses normal teardown, exercising the real database boundary.
            os.kill(info["pid"], signal.SIGTERM)
        with native_server(home, config, managed=True) as (request, _):
            assert history(request, session) == before
            assert request("GET", "/api/session/" + session + "/inbox")["data"] == [queued]
            assert len(calls) == 1
            # Native reconciliation returns the original durable receipt, including after delivery.
            # Inspect without waking the parked successor; a lost acknowledgement is not a new task.
            duplicate = send(request, session, "Must never replace completed A", id=first["id"], resume=False)
            assert duplicate["id"] == first["id"] and duplicate["sessionID"] == session
            assert duplicate["payload"]["text"] == first["payload"]["text"]
            assert history(request, session) == before and len(calls) == 1
            retry = send(request, session, "Must not replace parked B", id=queued["id"])
            assert retry == queued
            reached(2).release.set()
            settled(request, session)
            after = history(request, session)
            assert [item["id"] for item in after if item["type"] == "user"] == [first["id"], queued["id"]]
            assert len(calls) == 2
        return {"native_http_sqlite": True, "owned_process_hard_terminated": True,
            "completed_input_not_replayed": True, "parked_input_identity_and_order_restored": True,
            "lost_admission_ack_reconciled_by_native_id": True, "model_requests": 2,
            "inflight_external_side_effect_exactly_once_claimed": False}
