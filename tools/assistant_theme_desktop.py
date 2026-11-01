"""Exercise the compiled Windows Electron product in a fresh, isolated native profile."""

import base64
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

from tools.native_baseline import ROOT, environment, provenance


def run():
    if os.name != "nt":
        raise RuntimeError("Windows desktop acceptance must execute on Windows; it cannot be skipped")
    parent = ROOT / "runtime/baseline"
    parent.mkdir(parents=True, exist_ok=True)
    base = Path(tempfile.mkdtemp(prefix="assistant-theme-desktop-", dir=parent))
    product = base / "product"
    config = product / "native/config/opencode/service-im-assistant.json"
    config.parent.mkdir(parents=True)
    with socket.socket() as reserve:
        reserve.bind(("127.0.0.1", 0))
        port = reserve.getsockname()[1]
    config.write_text(json.dumps({"hostname": "127.0.0.1", "port": port}), encoding="utf-8")
    registration = product / "native/state/opencode/service-im-assistant.json"
    active = product / "session/DevToolsActivePort"
    env = environment("assistant-theme-desktop")
    env.update({"IM_ASSISTANT_DATA_ROOT": str(product), "IM_THEME_DESKTOP_ROOT": str(product),
                "OPENCODE_DESKTOP_REMOTE_DEBUGGING_PORT": "0"})
    bun = str(ROOT / provenance()["runtime"]["bun"])
    logdir = ROOT / ".reports/native"
    logdir.mkdir(parents=True, exist_ok=True)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    process = None

    def stop():
        if registration.is_file():
            subprocess.run([bun, str(ROOT / "tools/stop_baseline_service.ts"), str(registration)],
                           cwd=ROOT / "opencode/packages/cli", env=env,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30, check=True,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))

    try:
        with (logdir / "r4-theme-desktop-launch.log").open("wb") as output:
            process = subprocess.Popen([bun, "run", "script/desktop.ts", "--disable-renderer-backgrounding",
                                        "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows"],
                                       cwd=ROOT / "opencode/packages/im-assistant", env=env, stdout=output,
                                       stderr=subprocess.STDOUT, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            deadline = time.monotonic() + 75
            while not active.is_file() or not registration.is_file():
                if process.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError("The isolated compiled product did not expose its private test endpoint")
                time.sleep(.1)
            found = json.loads(registration.read_text(encoding="utf-8"))
            assert found["url"] == f"http://127.0.0.1:{port}"
            authorization = "Basic " + base64.b64encode(("opencode:" + found["password"]).encode()).decode()

            def request(method, path, payload=None):
                req = urllib.request.Request(found["url"] + path, method=method,
                                             data=None if payload is None else json.dumps(payload).encode(),
                                             headers={"Content-Type": "application/json", "Authorization": authorization})
                with opener.open(req, timeout=20) as response:
                    data = response.read()
                    return json.loads(data) if data else None

            sessions = [request("POST", "/api/session", {"title": title,
                        "location": {"directory": str(product / "session-location")}})["data"]["id"]
                        for title in ("Desktop layout acceptance", "Desktop second conversation")]
            env["IM_THEME_DESKTOP_SESSIONS"] = json.dumps(sessions)
            env["IM_THEME_WINDOW_PYTHON"] = sys.executable
            env["IM_THEME_WINDOW_LAUNCHER"] = str(process.pid)
            probe = subprocess.run([str(ROOT / provenance()["runtime"]["node"]),
                                    str(ROOT / "tools/assistant_theme_desktop.mjs")],
                                   cwd=ROOT, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace",
                                   timeout=180, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            (logdir / "r4-theme-desktop-renderer.log").write_text(probe.stdout + probe.stderr, encoding="utf-8")
            if probe.returncode:
                raise RuntimeError("Isolated desktop layout probe failed: " + probe.stderr[-3000:])
            result = json.loads(probe.stdout.strip().splitlines()[-1])
            assert result["status"] == "passed" and result["original_electron_app"]
            process.wait(timeout=20)
            assert len(request("GET", "/api/session")["data"]) == 2
            result.update(product_entry="packages/im-assistant/script/desktop.ts", profile_isolated=True,
                          credentials_inherited=False, model_requests=0, actual_qq_connection=False)
            (logdir / "r4-theme-desktop.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
            return result
    finally:
        if process is not None and process.poll() is None:
            # Only the exact Bun launcher/child tree created above, never a user's application by name.
            subprocess.run(["taskkill.exe", "/PID", str(process.pid), "/T", "/F"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            process.wait(timeout=20)
        stop()


if __name__ == "__main__":
    print(json.dumps(run(), indent=2))
