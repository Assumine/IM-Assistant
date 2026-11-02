import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import type { StorageDomain } from "../../../opencode/packages/plugin/src/promise/storage";
import { createDownloadModule, validate, validFilename } from "../src/module";
import {
  defaults,
  settingsOwner,
  readConfiguration,
} from "../src/configuration";

const executable = fileURLToPath(
  new URL("../../../runtime/tools/aria2-1.37.0/aria2c.exe", import.meta.url),
);
type Value = Exclude<Awaited<ReturnType<StorageDomain["get"]>>, undefined>;
const data = Buffer.alloc(1048576, 91);
const checksum = createHash("sha256").update(data).digest("hex");

function storage(): StorageDomain {
  const map = new Map<string, Value>();
  return {
    get: async (key) => map.get(key),
    set: async (key, value) => {
      map.set(key, value);
    },
    insert: async (key, value) => {
      if (map.has(key)) return false;
      map.set(key, value);
      return true;
    },
    remove: async (key) => {
      map.delete(key);
    },
    scan: async (options) => ({
      entries: [...map]
        .filter(([key]) => key.startsWith(options.prefix))
        .map(([key, value]) => ({ key, value }))
        .slice(0, options.limit ?? 200),
    }),
  };
}
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const result = await read();
    if (accept(result)) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Observable download state did not become ready");
}
async function setup(owned = storage(), home?: string, binary = executable) {
  const folder = home ?? (await mkdtemp(path.join(tmpdir(), "im-download-")));
  const notices: unknown[] = [];
  const module = createDownloadModule({
    home: folder,
    executable: binary,
    config: { ...defaults, enabled: true, reserveBytes: 0, enableDht: false },
  });
  const resource = module.open({
    storage: owned,
    client: {} as never,
    capability: {
      report: () => {},
      invalidate: () => {},
      notify: async (value) => {
        notices.push(value);
      },
      resolve: async () => {},
    },
  });
  const view = () =>
    resource.view!({ locale: "zh", signal: new AbortController().signal });
  const invoke = (
    action: string,
    values: object = {},
    target?: string,
    requestID = randomUUID(),
  ) =>
    resource.invoke!({
      id: "downloads",
      action,
      target,
      requestID,
      values: JSON.stringify(values),
      locale: "zh",
      signal: new AbortController().signal,
    });
  return {
    home: folder,
    storage: owned,
    resource,
    notices,
    view,
    invoke,
    close: () => resource.close(),
    cleanup: () =>
      rm(folder, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 50,
      }),
  };
}
async function source(held = false) {
  let reads = 0;
  const streams = new Set<() => void>();
  const server = createServer((request, response) => {
    reads++;
    const ranged = request.headers.range !== undefined;
    const start = Number(
      request.headers.range?.match(/^bytes=(\d+)-/)?.[1] ?? 0,
    );
    const headers = {
      "content-length": String(data.length - start),
      "accept-ranges": "bytes",
      ...(ranged
        ? {
            "content-range": `bytes ${start}-${data.length - 1}/${data.length}`,
          }
        : {}),
    };
    response.writeHead(ranged ? 206 : 200, headers);
    if (!held) {
      response.end(data.subarray(start));
      return;
    }
    let finish = () => {};
    const next = Math.min(data.length, start + 524288);
    response.write(data.subarray(start, next));
    finish = () => {
      if (!response.destroyed) response.end(data.subarray(next));
      streams.delete(finish);
    };
    streams.add(finish);
    response.once("close", () => streams.delete(finish));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Test HTTP source did not bind");
  return {
    uri: `http://127.0.0.1:${address.port}/payload.bin`,
    reads: () => reads,
    finish: () => {
      for (const finish of [...streams]) finish();
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

test("download input rejects file/system paths, credentials, reserved names and invalid hashes", () => {
  for (const uri of [
    "file:///C:/Windows/a",
    "ftp://example.test/a",
    "https://u:p@example.test/a",
    "magnet:?xt=bad",
  ])
    expect(() => validate({ title: "test", uri })).toThrow();
  for (const name of [
    "../escape",
    "CON.txt",
    "a:b",
    "a\\b",
    "a.",
    "NUL",
    "LPT2.mp4",
  ])
    expect(validFilename(name)).toBe(false);
  expect(validFilename("影片 2026.mkv")).toBe(true);
  expect(() =>
    validate({
      title: "test",
      uri: "https://example.test/file",
      checksum: "bad",
    }),
  ).toThrow();
  expect(
    validate({ title: "test", uri: "magnet:?xt=urn:btih:" + "1".repeat(40) })
      .uri,
  ).toStartWith("magnet:");
});

test("real aria2 writes and verifies exact HTTP bytes once for concurrent duplicate admission", async () => {
  const app = await setup(),
    http = await source();
  try {
    const key = randomUUID();
    const values = {
      title: "真实直链测试",
      uri: http.uri,
      filename: "payload.bin",
      checksum,
    };
    const results = await Promise.all([
      app.invoke("create", values, undefined, key),
      app.invoke("create", values, undefined, key),
    ]);
    expect(results.every((result) => result.state === "applied")).toBe(true);
    const done = await until(
      app.view,
      (view) => view.items[0]?.status === "已完成",
    );
    expect(done.items).toHaveLength(1);
    const id = done.items[0]!.id;
    expect(
      createHash("sha256")
        .update(await readFile(path.join(app.home, "files", id, "payload.bin")))
        .digest("hex"),
    ).toBe(checksum);
    expect(done.items[0]!.progress).toBe(100);
    const before = http.reads();
    await app.invoke("create", values, undefined, key);
    expect(http.reads()).toBe(before);
    expect(
      (
        await app.invoke(
          "create",
          { ...values, filename: "changed.bin" },
          undefined,
          key,
        )
      ).state,
    ).toBe("rejected");
  } finally {
    await app.close();
    await http.close();
    await app.cleanup();
  }
}, 30000);

test("real engine pause, resume and cancel preserve owned partial files and replay receipts", async () => {
  const app = await setup(),
    http = await source(true);
  try {
    expect(
      (
        await app.invoke("create", {
          title: "受控慢速测试",
          uri: http.uri,
          filename: "partial.bin",
        })
      ).state,
    ).toBe("applied");
    await until(
      async () => http.reads(),
      (count) => count > 0,
    );
    const id = (await app.view()).items[0]!.id;
    const pauseID = randomUUID();
    expect((await app.invoke("pause", {}, id, pauseID)).state).toBe("applied");
    expect((await app.view()).items[0]!.status).toBe("已暂停");
    expect((await app.invoke("pause", {}, id, pauseID)).state).toBe("applied");
    expect((await app.invoke("resume", {}, id)).state).toBe("applied");
    const cancelled = await app.invoke("cancel", {}, id);
    expect(cancelled.state).toBe("applied");
    expect((await app.view()).items[0]!.status).toContain("文件保留");
    expect(
      (await stat(path.join(app.home, "files", id, "partial.bin"))).isFile(),
    ).toBe(true);
  } finally {
    await app.close();
    await http.close();
    await app.cleanup();
  }
}, 30000);

test("restart keeps records but does not start an engine or replay transfers until explicit resume", async () => {
  const owned = storage(),
    app = await setup(owned),
    http = await source(true);
  let resumed: Awaited<ReturnType<typeof setup>> | undefined;
  try {
    await app.invoke("create", {
      title: "可恢复测试",
      uri: http.uri,
      filename: "resume.bin",
      checksum,
    });
    await until(
      async () => http.reads(),
      (count) => count > 0,
    );
    await until(app.view, (view) => (view.items[0]?.progress ?? 0) >= 25);
    const id = (await app.view()).items[0]!.id;
    await app.close();
    const before = http.reads();
    resumed = await setup(owned, app.home);
    const waiting = await resumed.view();
    expect(waiting.items[0]!.status).toContain("运行曾中断");
    expect(waiting.refreshAfterMs).toBeUndefined();
    expect(http.reads()).toBe(before);
    expect((await resumed.invoke("resume", {}, id)).state).toBe("applied");
    await until(
      async () => http.reads(),
      (count) => count > before,
    );
    http.finish();
    await until(resumed.view, (view) => view.items[0]?.status === "已完成");
    expect(
      createHash("sha256")
        .update(await readFile(path.join(app.home, "files", id, "resume.bin")))
        .digest("hex"),
    ).toBe(checksum);
  } finally {
    await resumed?.close();
    await app.close();
    await http.close();
    await app.cleanup();
  }
}, 30000);

test("real aria2 accepts a tracker-free magnet without claiming metadata is a completed movie", async () => {
  const app = await setup();
  try {
    const admitted = await app.invoke("create", {
      title: "离线磁链受理测试",
      uri: "magnet:?xt=urn:btih:" + "2".repeat(40),
    });
    expect(admitted.state).toBe("applied");
    const view = await app.view();
    expect(view.items[0]!.status).not.toBe("已完成");
    expect(view.items[0]!.progress).toBeUndefined();
    expect((await app.invoke("cancel", {}, view.items[0]!.id)).state).toBe(
      "applied",
    );
  } finally {
    await app.close();
    await app.cleanup();
  }
}, 30000);

test("a wrong checksum remains an engine error and never produces a completion notice", async () => {
  const app = await setup(),
    http = await source();
  try {
    await app.invoke("create", {
      title: "校验失败测试",
      uri: http.uri,
      filename: "bad-hash.bin",
      checksum: "0".repeat(64),
    });
    const view = await until(
      app.view,
      (view) => view.items[0]?.status === "引擎报错",
    );
    expect(
      view.items[0]!.fields.some((field) => field.value.includes("32")),
    ).toBe(true);
    expect(app.notices).toHaveLength(0);
  } finally {
    await app.close();
    await http.close();
    await app.cleanup();
  }
}, 30000);

test("admission intent survives missing engine and the same request is never blindly resubmitted", async () => {
  const app = await setup(undefined, undefined, executable + ".missing"),
    http = await source();
  try {
    const key = randomUUID(),
      values = { title: "未知受理测试", uri: http.uri };
    expect((await app.invoke("create", values, undefined, key)).state).toBe(
      "uncertain",
    );
    expect((await app.invoke("create", values, undefined, key)).state).toBe(
      "applied",
    );
    expect((await app.view()).items).toHaveLength(1);
    expect(http.reads()).toBe(0);
    await app.close();
    expect((await app.invoke("create", values)).state).toBe("rejected");
  } finally {
    await app.close();
    await http.close();
    await app.cleanup();
  }
});

test("download configuration is default off, rejects executor injection and preserves concurrent changes", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "im-download-config-"));
  try {
    expect((await readConfiguration(home)).enabled).toBe(false);
    const owner = settingsOwner(home),
      signal = new AbortController().signal,
      previous = await owner.read(signal);
    await expect(
      owner.write(
        {
          revision: previous.revision,
          text: JSON.stringify({ ...defaults, executable: "other.exe" }),
        },
        signal,
      ),
    ).rejects.toThrow();
    const next = await owner.write(
      {
        revision: previous.revision,
        text: JSON.stringify({ ...defaults, enabled: true }),
      },
      signal,
    );
    expect(next).toBeDefined();
    expect(
      await owner.write(
        { revision: previous.revision, text: previous.text },
        signal,
      ),
    ).toBeUndefined();
    expect((await readConfiguration(home)).enabled).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
