"""Test-only subprocess handle. Tests interact through public RPC, not private files."""

import asyncio
import os
from pathlib import Path
import sys
import uuid

from sdk.transport import RpcPeer

ROOT = Path(__file__).resolve().parents[2]


class FixtureClient:
    def __init__(self, variant, root, instance="instance-test"):
        self.variant, self.root, self.instance = variant, Path(root), instance
        self.generation = "boot-"+uuid.uuid4().hex
        self.process = None
        self.peer = None

    async def start(self):
        environment = {key:value for key,value in os.environ.items()
                       if key.upper() in {"SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP"}}
        environment["PYTHONDONTWRITEBYTECODE"] = "1"
        self.process = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "tests.backend_fixtures.backend_"+self.variant,
            "--data-root", str(self.root), "--instance-id", self.instance,
            "--generation", self.generation, cwd=ROOT,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env=environment)
        self.peer = RpcPeer(self.process.stdout, self.process.stdin).start()
        await self.call("runtime.hello")
        return self

    async def call(self, method, params=None, *, principal="principal-test", **kwargs):
        return await self.peer.request(method, {"protocol_version":1,"principal_id":principal,
                                               "backend_instance_id":self.instance,
                                               "runtime_generation":self.generation, **(params or {})}, **kwargs)

    async def open(self, ident="open-test", **kwargs):
        result = await self.call("conversations.open", {"request_id":ident,"mode":"create",
                                 "connection_ref":{"id":"connection-1","revision":"r-1"}}, **kwargs)
        return result["conversation_ref"]

    async def submit(self, ref, ident="input-test", text="hello", **kwargs):
        return await self.call("inputs.submit", {"conversation_ref":ref,"request_id":ident,
                               "connection_ref":{"id":"connection-1","revision":"r-1"},
                               "input":{"parts":[{"type":"text","text":text}],"attachments":[]}}, **kwargs)

    async def completed(self, ref, ident="input-test"):
        async with asyncio.timeout(3):
            while True:
                result = await self.call("inputs.lookup", {"conversation_ref":ref,"request_id":ident})
                if result.get("receipt",{}).get("execution_state") == "completed":
                    return result
                await asyncio.sleep(0.01)

    async def close(self, *, crash=False):
        if self.peer:
            await self.peer.close()
        if self.process:
            if crash and self.process.returncode is None:
                self.process.kill()  # Only this newly-created, owned test process.
            try:
                async with asyncio.timeout(3):
                    await self.process.wait()
            except TimeoutError:
                self.process.kill()
                await self.process.wait()
            # Drain stderr for diagnostics; never expose credentials or upstream data.
            error = await self.process.stderr.read(16384)
            if error and not crash:
                raise AssertionError("Fixture process failed: "+error.decode(errors="replace"))
