import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import type { Configuration } from "./configuration";

export type Transfer = {
  gid: string;
  status: string;
  totalLength?: string;
  completedLength?: string;
  downloadSpeed?: string;
  errorCode?: string;
  followedBy?: string[];
};
export class EngineError extends Error {
  constructor(readonly kind: "missing" | "unknown") {
    super("Download engine result is unavailable");
  }
}
export class Engine {
  readonly key = randomBytes(16).toString("hex");
  private child?: ChildProcess;
  private endpoint?: string;
  private token = randomBytes(32).toString("hex");
  private opening?: Promise<void>;
  private socket?: WebSocket;
  private stopped = false;
  private pending = new Set<AbortController>();
  constructor(
    readonly options: {
      executable: string;
      home: string;
      config: Configuration;
      changed: (gid: string) => Promise<void>;
    },
  ) {}
  get started() {
    return !!this.child && this.child.exitCode === null && !this.stopped;
  }
  async start() {
    if (this.stopped) throw new EngineError("unknown");
    if (this.opening) return this.opening;
    this.opening = this.open();
    return this.opening;
  }
  private async open() {
    const data = await readFile(this.options.executable);
    if (
      createHash("sha256").update(data).digest("hex") !==
      "be2099c214f63a3cb4954b09a0becd6e2e34660b886d4c898d260febfe9d70c2"
    )
      throw new EngineError("unknown");
    await mkdir(this.options.home, { recursive: true });
    if (this.stopped) throw new EngineError("unknown");
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close();
          reject(new EngineError("unknown"));
          return;
        }
        server.close((error) =>
          error ? reject(error) : resolve(address.port),
        );
      });
    });
    this.endpoint = `http://127.0.0.1:${port}/jsonrpc`;
    if (this.stopped) throw new EngineError("unknown");
    const config = this.options.config;
    this.child = spawn(
      this.options.executable,
      [
        "--no-conf=true",
        "--enable-rpc=true",
        "--rpc-listen-all=false",
        `--rpc-listen-port=${port}`,
        `--rpc-secret=${this.token}`,
        "--rpc-allow-origin-all=false",
        "--enable-color=false",
        "--console-log-level=error",
        "--summary-interval=0",
        "--file-allocation=none",
        "--allow-overwrite=false",
        "--auto-file-renaming=false",
        "--continue=true",
        "--auto-save-interval=1",
        "--follow-metalink=false",
        "--follow-torrent=false",
        "--seed-time=0",
        "--bt-enable-lpd=false",
        `--enable-dht=${config.enableDht}`,
        `--enable-dht6=${config.enableDht}`,
        `--dht-file-path=${path.join(this.options.home, "dht.dat")}`,
        `--dht-file-path6=${path.join(this.options.home, "dht6.dat")}`,
        `--dir=${this.options.home}`,
        `--max-concurrent-downloads=${config.maxConcurrent}`,
        `--max-download-limit=${config.perDownloadLimit}`,
        `--max-overall-download-limit=${config.perDownloadLimit * config.maxConcurrent}`,
      ],
      { cwd: this.options.home, windowsHide: true, stdio: "ignore" },
    );
    this.child.once("error", () => {});
    const deadline = Date.now() + 8000;
    while (
      Date.now() < deadline &&
      !this.stopped &&
      this.child.exitCode === null
    ) {
      try {
        await this.call("getVersion");
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    await this.call("getVersion");
    this.socket = new WebSocket(this.endpoint.replace("http:", "ws:"));
    this.socket.addEventListener("error", () => {});
    this.socket.addEventListener("message", (event) => {
      if (
        this.stopped ||
        typeof event.data !== "string" ||
        event.data.length > 4096
      )
        return;
      try {
        const value = JSON.parse(event.data);
        if (!/^aria2\.on(?:Download|BtDownload)/.test(value.method ?? ""))
          return;
        const gid = value.params?.[0]?.gid;
        if (typeof gid === "string" && /^[0-9a-f]{16}$/.test(gid))
          void this.options.changed(gid).catch(() => {});
      } catch {
        /* An invalid event never drives another operation. */
      }
    });
  }
  async call<T = unknown>(
    method: string,
    parameters: readonly unknown[] = [],
    signal?: AbortSignal,
  ): Promise<T> {
    if (!this.endpoint || this.stopped) throw new EngineError("unknown");
    const controller = new AbortController();
    this.pending.add(controller);
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: this.key,
          method: "aria2." + method,
          params: ["token:" + this.token, ...parameters],
        }),
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(8000),
          ...(signal ? [signal] : []),
        ]),
      });
      const text = await response.text();
      if (text.length > 2097152) throw new EngineError("unknown");
      const result = JSON.parse(text);
      if (result.error) {
        throw new EngineError(
          result.error.code === 1 &&
          method === "tellStatus" &&
          /(?:not found|is not found)/i.test(String(result.error.message))
            ? "missing"
            : "unknown",
        );
      }
      if (!response.ok) throw new EngineError("unknown");
      return result.result;
    } catch (error) {
      if (error instanceof EngineError) throw error;
      throw new EngineError("unknown");
    } finally {
      this.pending.delete(controller);
    }
  }
  status(gid: string, signal?: AbortSignal) {
    return this.call<Transfer>(
      "tellStatus",
      [
        gid,
        [
          "gid",
          "status",
          "totalLength",
          "completedLength",
          "downloadSpeed",
          "errorCode",
          "followedBy",
        ],
      ],
      signal,
    );
  }
  async close() {
    if (this.stopped) return;
    this.socket?.close();
    const child = this.child;
    if (child && child.exitCode === null) {
      try {
        await this.call("pauseAll");
        await this.call("shutdown");
      } catch {
        /* Only this owned child may be terminated below. */
      }
      await new Promise<void>((resolve, reject) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          child.kill();
        }, 5000);
        const deadline = setTimeout(() => {
          clearTimeout(timer);
          reject(new EngineError("unknown"));
        }, 15000);
        child.once("exit", () => {
          clearTimeout(timer);
          clearTimeout(deadline);
          resolve();
        });
      });
    }
    this.stopped = true;
    for (const controller of this.pending) controller.abort();
  }
}
