"""Serial release measurements on disposable native profiles, never background monitoring."""

import ctypes
from ctypes import wintypes
import json
import math
import os
from pathlib import Path
import statistics
import subprocess
import tempfile
import time

from tools.native_api_smoke import native_server
from tools.native_baseline import ROOT
from tools.native_conversation_smoke import controlled_model
from tools.release_native_smoke import create, history, send, settled

REFERENCE = "ab68bc75348da9e3e4593766345f5fb07b6291b6"


def runtime_identity():
    """R5 changes test fixtures only; verify equivalence before reusing its production code as a reference.

    The earlier R4 unskinned presentation baseline remains separately anchored to its own revision.
    Do not reuse this identity argument if a production source or module manifest changes.
    """
    git = "C:/Program Files/Git/cmd/git.exe" if os.name == "nt" else "git"
    changed = subprocess.check_output([git, "diff", "--name-only", "-z", REFERENCE, "--", "opencode", "modules"], cwd=ROOT)
    names = [name for name in changed.decode().split("\0") if name]
    assert names, "Expected the R5 typed fixture changes"
    validation = {"opencode/packages/server/script/codex-backend-smoke.ts",
                  "opencode/packages/server/script/codex-product-smoke.ts"}
    assert all("/e2e/" in name or "/test/" in name or name in validation for name in names), "Production sources changed; recreate a real reference checkout"
    untracked = subprocess.check_output([git, "ls-files", "--others", "--exclude-standard", "-z", "--", "opencode", "modules"], cwd=ROOT)
    assert not untracked, "Untracked runtime sources require a separate reference checkout"
    return {"reference_commit": REFERENCE, "production_sources_identical": True,
        "reference_execution": "same verified production code; R5 changes are test-only",
        "interpretation": "paired local samples measure variability; no R5 runtime speedup is claimed"}


def process_sample(pid):
    """Read our known child's Windows counters once; release the handle immediately."""
    if os.name != "nt":
        raise RuntimeError("This release measurement requires Windows; do not silently skip it")

    class Memory(ctypes.Structure):
        _fields_ = [("cb", wintypes.DWORD), ("faults", wintypes.DWORD),
            *[(name, ctypes.c_size_t) for name in ("peak", "working", "pool_peak", "pool",
                "nonpaged_peak", "nonpaged", "pagefile", "pagefile_peak", "private")]]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE, *([ctypes.POINTER(wintypes.FILETIME)] * 4)]
    psapi = ctypes.WinDLL("psapi", use_last_error=True)
    psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Memory), wintypes.DWORD]
    handle = kernel.OpenProcess(0x1000 | 0x10, False, pid)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        created, ended, system, user = (wintypes.FILETIME() for _ in range(4))
        if not kernel.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(ended), ctypes.byref(system), ctypes.byref(user)):
            raise ctypes.WinError(ctypes.get_last_error())
        memory = Memory()
        memory.cb = ctypes.sizeof(memory)
        if not psapi.GetProcessMemoryInfo(handle, ctypes.byref(memory), memory.cb):
            raise ctypes.WinError(ctypes.get_last_error())
        ticks = lambda value: (value.dwHighDateTime << 32) + value.dwLowDateTime
        return {"cpu_seconds": (ticks(system) + ticks(user)) / 10000000,
            "working_set_bytes": memory.working, "private_bytes": memory.private}
    finally:
        kernel.CloseHandle(handle)


def native_samples():
    identity = runtime_identity()
    parent = ROOT / "runtime/baseline"
    samples = []
    # Three interleaved pairs, all serial; independent cold profiles with the same warmed toolchain.
    for pair in range(3):
        for arm in ("reference", "candidate"):
            with tempfile.TemporaryDirectory(prefix="release-perf-", dir=parent) as temporary, controlled_model() as (config, calls, reached):
                home = Path(temporary)
                start = time.perf_counter()
                with native_server(home, config, managed=True) as (request, info):
                    startup = (time.perf_counter() - start) * 1000
                    session = create(request, home, "Synthetic release performance")
                    for index in range(5):
                        send(request, session, "Identical history turn " + str(index))
                        reached(index + 1).release.set()
                        settled(request, session)
                    assert len(history(request, session)) == 15
                    durations = []
                    for _ in range(5):
                        start = time.perf_counter()
                        page = request("GET", "/api/session/" + session + "/message?limit=10&order=desc")["data"]
                        durations.append((time.perf_counter() - start) * 1000)
                        assert len(page) == 10
                    start = time.perf_counter()
                    send(request, session, "Identical next input, hold before first token")
                    admission = (time.perf_counter() - start) * 1000
                    held = reached(6)
                    assert not held.release.is_set()
                    held.release.set()
                    settled(request, session)
                    first = process_sample(info["pid"])
                    idle_started = time.perf_counter()
                    # A deliberate bounded measurement interval; no UI readiness or execution relies on sleeping.
                    time.sleep(3)
                    idle_seconds = time.perf_counter() - idle_started
                    last = process_sample(info["pid"])
                    cpu = max(0, last["cpu_seconds"] - first["cpu_seconds"])
                    assert len(calls) == 6, "The idle window started unexpected model work"
                    samples.append({"pair": pair + 1, "arm": arm, "cold_profile_service_ready_ms": startup,
                        "history_page_10_ms": durations, "history_page_10_median_ms": statistics.median(durations),
                        "admission_before_first_token_ms": admission, "idle_window_seconds": idle_seconds,
                        "idle_cpu_single_core_percent": cpu / idle_seconds * 100,
                        "idle_cpu_host_percent": cpu / idle_seconds / os.cpu_count() * 100,
                        "idle_private_bytes": last["private_bytes"], "idle_working_set_bytes": last["working_set_bytes"],
                        "idle_model_requests": 0, "model_requests": len(calls)})
    keys = ["cold_profile_service_ready_ms", "history_page_10_median_ms", "admission_before_first_token_ms",
        "idle_cpu_single_core_percent", "idle_cpu_host_percent", "idle_private_bytes", "idle_working_set_bytes"]
    assert all(math.isfinite(sample[key]) and sample[key] >= 0 for sample in samples for key in keys)
    return {"identity": identity, "fixture": {"completed_turns": 5, "native_history_rows": 15,
        "history_page_size": 10, "history_reads_per_sample": 5, "pairs": 3, "serial": True},
        "samples": samples, "median": {arm: {key: statistics.median(sample[key] for sample in samples if sample["arm"] == arm)
            for key in keys} for arm in ("reference", "candidate")},
        "limits": ["cold profile and service readiness, not OS cold boot or installer startup",
            "HTTP history time excludes renderer paint; the separate production browser benchmark measures tab rendering",
            "idle counters cover only this native service process for three seconds, not all desktop child processes",
            "no machine-dependent speed or memory pass threshold; no production credentials or background monitor"]}


def save(result):
    path = ROOT / ".reports/native/r5-performance-native.json"
    path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return path


if __name__ == "__main__":
    measured = native_samples()
    save(measured)
    print(json.dumps(measured["median"], indent=2))
