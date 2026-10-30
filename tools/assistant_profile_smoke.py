"""Exercise the product entry against native persistence alongside an unrelated native profile."""
import base64
import json
import os
from pathlib import Path
import socket
import subprocess
import time
import urllib.request
import uuid

from tools.native_api_smoke import native_server
from tools.native_baseline import ROOT, environment, provenance


def profile_smoke():
    base = ROOT / "runtime/baseline" / ("assistant-profile-" + uuid.uuid4().hex[:12])
    unrelated = base / "unrelated"
    unrelated.mkdir(parents=True)
    product = base / "product"
    config = product / "native/config/opencode/service-im-assistant.json"
    config.parent.mkdir(parents=True)
    with socket.socket() as reserve:
        reserve.bind(("127.0.0.1", 0))
        port = reserve.getsockname()[1]
    config.write_text(json.dumps({"hostname": "127.0.0.1", "port": port}), encoding="utf-8")
    sentinel = unrelated / "do-not-import.json"
    sentinel.write_text('{"username":"other-profile"}', encoding="utf-8")
    legacy_desktop = unrelated / "wrong-desktop-root"
    env = environment("profile-test")
    env.update({"IM_ASSISTANT_DATA_ROOT": str(product), "BASELINE_PRODUCT_ROOT": str(product),
        "OPENCODE_DESKTOP_REMOTE_DEBUGGING_PORT": "0", "OPENCODE_CONFIG": str(sentinel),
        "OPENCODE_DB": str(unrelated / "do-not-write.db"), "OPENCODE_CONFIG_CONTENT": "invalid inherited content",
        "OPENCODE_DESKTOP_TEST_ROOT": str(legacy_desktop)})
    # These are test-window switches, never defaults in the application.
    flags = ["--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows"]
    record = provenance()
    bun = str(ROOT / record["runtime"]["bun"])
    # The product's developer entry must work without Bun installed globally.
    env["PATH"] = os.pathsep.join(part for part in env["PATH"].split(os.pathsep)
        if Path(part).resolve() != Path(bun).parent.resolve())
    registration = product / "native/state/opencode/service-im-assistant.json"
    logdir = ROOT / ".reports/native"
    logdir.mkdir(parents=True, exist_ok=True)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def stop():
        if registration.is_file():
            subprocess.run([bun, str(ROOT / "tools/stop_baseline_service.ts"), str(registration)],
                cwd=ROOT / "opencode/packages/cli", env=env, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, timeout=30, check=True,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))

    with native_server(unrelated) as (other_request, other_info):
        other_location = unrelated / "location"
        other_location.mkdir()
        other_session = other_request("POST", "/api/session", {
            "title": "Other profile sentinel", "location": {"directory": str(other_location)}})["data"]
        created = None
        pending = None
        boots = []
        previous_pid = None
        password = None
        try:
            for attempt in range(2):
                active = product / "session/DevToolsActivePort"
                active.unlink(missing_ok=True)
                with (logdir / f"assistant-launch-{attempt}.log").open("wb") as output:
                    process = subprocess.Popen([bun, "run", "script/desktop.ts", *flags],
                        cwd=ROOT / "opencode/packages/im-assistant", env=env,
                        stdout=output, stderr=subprocess.STDOUT,
                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                    try:
                        deadline = time.monotonic() + 60
                        while not active.is_file():
                            if process.poll() is not None or time.monotonic() > deadline:
                                raise RuntimeError("Product entry did not expose its private desktop test endpoint")
                            time.sleep(.1)
                        probe = subprocess.run([str(ROOT / record["runtime"]["node"]), str(ROOT / "tools/native_desktop_smoke.mjs")],
                            cwd=ROOT, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=75,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                        (logdir / f"assistant-renderer-{attempt}.log").write_text(probe.stdout + probe.stderr, encoding="utf-8")
                        if probe.returncode:
                            raise RuntimeError("Product renderer failed: " + probe.stderr[-3500:])
                        boots.append(json.loads(probe.stdout.strip().splitlines()[-1]))
                        process.wait(timeout=20)
                    finally:
                        if process.poll() is None:
                            # The product entry owns Electron as a child; terminate only this still-owned tree on failure.
                            subprocess.run(["taskkill.exe", "/PID", str(process.pid), "/T", "/F"],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                            process.wait(timeout=15)
                found = json.loads(registration.read_text(encoding="utf-8"))
                assert found["url"] == f"http://127.0.0.1:{port}"
                assert found["pid"] != other_info["pid"]
                authorization = "Basic " + base64.b64encode(("opencode:" + found["password"]).encode()).decode()

                def request(method, path, payload=None):
                    req = urllib.request.Request(found["url"] + path, method=method,
                        data=None if payload is None else json.dumps(payload).encode(),
                        headers={"Content-Type": "application/json", "Authorization": authorization})
                    with opener.open(req, timeout=15) as response:
                        content = response.read()
                        return json.loads(content) if content else None

                if attempt == 0:
                    created = request("POST", "/api/session", {"title": "Assistant profile persistence",
                        "location": {"directory": str(product / "session-location")}})["data"]
                    pending = request("POST", "/api/session/" + created["id"] + "/prompt",
                        {"text": "Persist across product reopen", "delivery": "queue", "resume": False})["data"]
                    password = found["password"]
                    previous_pid = found["pid"]
                else:
                    assert found["pid"] != previous_pid, "Server was not actually restarted"
                    assert found["password"] == password, "Native service credential did not persist"
                    restored = request("GET", "/api/session/" + created["id"])["data"]
                    assert restored["title"] == created["title"]
                    assert request("GET", "/api/session/" + created["id"] + "/inbox")["data"] == [pending]
                assert [s["id"] for s in other_request("GET", "/api/session")["data"]] == [other_session["id"]]
                assert all(s["id"] != other_session["id"] for s in request("GET", "/api/session")["data"])
                projects = request("GET", "/api/project")
                assert projects and all(Path(item["canonical"]).resolve().is_relative_to(product.resolve())
                                        and not item.get("vcs") for item in projects), "Assistant adopted an external project"
                stop()
            assert sentinel.read_text(encoding="utf-8") == '{"username":"other-profile"}'
            assert not (unrelated / "do-not-write.db").exists()
            assert not legacy_desktop.exists()
            assert (product / "native/data/opencode/opencode.db").is_file()
            assert (product / "desktop/opencode.settings").is_file()
            return {"product_entry": "packages/im-assistant/script/desktop.ts", "boots": boots,
                "managed_location_composer_ready": True, "independent_native_service": True,
                "parent_checkout_not_discovered": True,
                "unrelated_profile_unchanged": True, "native_session_and_inbox_preserved": True,
                "service_credential_preserved": True, "requires_qq_or_model_login": False,
                "external_model_calls": 0}
        finally:
            stop()


if __name__ == "__main__":
    receipt = profile_smoke()
    (ROOT / ".reports/native/assistant-profile-smoke.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(receipt, indent=2))
