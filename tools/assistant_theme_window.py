"""Control only the Windows window descending from an explicitly owned isolated test launcher."""

import argparse
import ctypes
from ctypes import wintypes
import json
from pathlib import Path

from tools.native_baseline import ROOT, provenance


class ProcessEntry(ctypes.Structure):
    _fields_ = [("size", wintypes.DWORD), ("usage", wintypes.DWORD), ("pid", wintypes.DWORD),
                ("heap", ctypes.c_size_t), ("module", wintypes.DWORD), ("threads", wintypes.DWORD),
                ("parent", wintypes.DWORD), ("priority", wintypes.LONG), ("flags", wintypes.DWORD),
                ("name", wintypes.WCHAR * 260)]


def window(launcher, width=None, height=None, maximize=False):
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    user = ctypes.WinDLL("user32", use_last_error=True)
    kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    kernel.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry)]
    kernel.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry)]

    def executable(pid):
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return None
        try:
            buffer = ctypes.create_unicode_buffer(32768)
            length = wintypes.DWORD(len(buffer))
            if not kernel.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(length)):
                return None
            return Path(buffer.value).resolve()
        finally:
            kernel.CloseHandle(handle)

    assert executable(launcher) == (ROOT / provenance()["runtime"]["bun"]).resolve(), "Unknown test launcher"
    snapshot = kernel.CreateToolhelp32Snapshot(2, 0)
    assert snapshot and snapshot != wintypes.HANDLE(-1).value
    parents = {}
    try:
        entry = ProcessEntry()
        entry.size = ctypes.sizeof(entry)
        more = kernel.Process32FirstW(snapshot, ctypes.byref(entry))
        while more:
            parents[entry.pid] = entry.parent
            more = kernel.Process32NextW(snapshot, ctypes.byref(entry))
    finally:
        kernel.CloseHandle(snapshot)
    owned = {launcher}
    while True:
        children = {pid for pid, parent in parents.items() if parent in owned}
        if children <= owned:
            break
        owned.update(children)
    allowed = {path.resolve() for path in (ROOT / "opencode/node_modules/.bun").glob(
        "electron@44.9.1*/node_modules/electron/dist/electron.exe")}
    owners = {pid for pid in owned if executable(pid) in allowed}
    assert owners, "The isolated launcher has no pinned Electron child"
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user.IsWindowVisible.argtypes = [wintypes.HWND]
    user.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    user.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    user.SetForegroundWindow.argtypes = [wintypes.HWND]
    user.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT]
    user.GetDpiForWindow.argtypes = [wintypes.HWND]
    user.IsZoomed.argtypes = [wintypes.HWND]
    candidates = []

    @callback_type
    def visit(hwnd, _):
        pid = wintypes.DWORD()
        user.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value not in owners or not user.IsWindowVisible(hwnd):
            return True
        rect = wintypes.RECT()
        user.GetWindowRect(hwnd, ctypes.byref(rect))
        if rect.right - rect.left >= 600 and rect.bottom - rect.top >= 400:
            candidates.append(hwnd)
        return True

    user.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
    user.EnumWindows(visit, 0)
    assert len(candidates) == 1, "The isolated native window could not be identified uniquely"
    hwnd = candidates[0]
    user.SetProcessDpiAwarenessContext.argtypes = [wintypes.HANDLE]
    user.SetProcessDpiAwarenessContext(wintypes.HANDLE(-4))
    dpi = user.GetDpiForWindow(hwnd)
    assert dpi >= 96
    if maximize:
        user.ShowWindow(hwnd, 3)
    elif width is not None:
        assert 800 <= width <= 1600 and height is not None and 600 <= height <= 1000
        user.ShowWindow(hwnd, 9)
        assert user.SetWindowPos(hwnd, None, 0, 0, round(width * dpi / 96), round(height * dpi / 96), 0x0002 | 0x0040)
    user.SetForegroundWindow(hwnd)
    rect = wintypes.RECT()
    assert user.GetWindowRect(hwnd, ctypes.byref(rect))
    return {"width": (rect.right - rect.left) * 96 / dpi, "height": (rect.bottom - rect.top) * 96 / dpi,
            "dpi": dpi, "maximized": bool(user.IsZoomed(hwnd)), "owned_launcher": True}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--launcher", type=int, required=True)
    parser.add_argument("--width", type=int)
    parser.add_argument("--height", type=int)
    parser.add_argument("--maximize", action="store_true")
    args = parser.parse_args()
    print(json.dumps(window(args.launcher, args.width, args.height, args.maximize)))
