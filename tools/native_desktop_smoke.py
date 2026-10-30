"""Launch and reopen the original Electron bundle using its own test-root support."""
import json
from pathlib import Path
import socket
import subprocess
import time
import uuid

from tools.native_baseline import ROOT, environment, provenance


def desktop_smoke():
    # This is the ORIGINAL upstream isolated-server port, not a product port choice.
    with socket.socket() as check:
        check.bind(("127.0.0.1", 3084))
    profile = "desktop-smoke-" + uuid.uuid4().hex[:12]
    env = environment(profile)
    base = ROOT / "runtime/baseline" / profile
    test_root = base / "ui"
    record = provenance()
    electrons = list((ROOT / "opencode/node_modules/.bun").glob("electron@44.9.1*/node_modules/electron/dist/electron.exe"))
    if len(electrons) != 1:
        raise RuntimeError("Install the locked Electron runtime using bun run install-electron")
    env.update({
        "OPENCODE_DESKTOP_TEST_ROOT": str(test_root),
        "OPENCODE_DESKTOP_CLI_DEV": str(ROOT / "opencode/packages/cli"),
        "OPENCODE_DESKTOP_ISOLATED_SERVER": "1", "OPENCODE_DESKTOP_SERVER_CHANNEL": "local",
        "OPENCODE_VERSION": record["package_version"], "OPENCODE_DESKTOP_REMOTE_DEBUGGING_PORT": "0",
        "OPENCODE_CONFIG_CONTENT": '{"update":"disable","share":"disabled"}',
    })
    log = ROOT / ".reports/native/desktop-smoke.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    try:
        boots = []
        for attempt in range(2):
            active = test_root / "session/DevToolsActivePort"
            active.unlink(missing_ok=True)
            with log.with_name(f"desktop-smoke-launch-{attempt}.log").open("wb") as output:
                app = subprocess.Popen([str(electrons[0]), "--disable-renderer-backgrounding",
                    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
                    str(ROOT / "opencode/packages/desktop")],
                    cwd=ROOT / "opencode/packages/desktop", env=env, stdout=output, stderr=subprocess.STDOUT,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                try:
                    deadline = time.monotonic() + 45
                    while not active.is_file():
                        if app.poll() is not None or time.monotonic() > deadline:
                            raise RuntimeError("Original desktop did not expose its private test endpoint")
                        time.sleep(.1)
                    result = subprocess.run([str(ROOT / record["runtime"]["node"]), str(ROOT / "tools/native_desktop_smoke.mjs")],
                        cwd=ROOT, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=75,
                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                    log.write_text(result.stdout + result.stderr, encoding="utf-8")
                    if result.returncode:
                        raise RuntimeError("Original desktop smoke failed: " + result.stderr[-3500:])
                    boots.append(json.loads(result.stdout.strip().splitlines()[-1]))
                    app.wait(timeout=15)
                finally:
                    if app.poll() is None:
                        app.terminate()
                        app.wait(timeout=15)
        receipt = {"original_electron_app": True, "boots": boots, "credentials_inherited": False}
        (log.with_suffix(".json")).write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
        return receipt
    finally:
        registration = test_root / "desktop/opencode/service-local.json"
        if registration.is_file():
            subprocess.run([str(ROOT / record["runtime"]["bun"]), str(ROOT / "tools/stop_baseline_service.ts"), str(registration)],
                cwd=ROOT / "opencode/packages/cli", env=env, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, timeout=30, check=True,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))


if __name__ == "__main__":
    print(json.dumps(desktop_smoke(), indent=2))
