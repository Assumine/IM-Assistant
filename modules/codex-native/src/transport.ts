import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"
import path from "node:path"
import { policy, verifiedVersion, verifyProfile, type Profile } from "./profile"

// Lifecycle ownership within the native application process, not a task scheduler.
// Cross-process ownership must be provided by the application service before publication.
const leases = new Set<string>()

export interface Notification {
  method: string
  params: Record<string, unknown>
}

export class NativeError extends Error {
  constructor(readonly code: number, message: string) {
    super(message)
    this.name = "NativeError"
  }
}

export class OutcomeUnknown extends Error {
  constructor(readonly method: string) {
    super(`${method}: native response unavailable; reconcile native state before retrying`)
    this.name = "OutcomeUnknown"
  }
}

export interface Launch {
  executable: string
  profile: Profile
  apiKey?: string
  timeoutMs?: number
}

// Only RPC correlation lives here. No conversation history, business queue, retries or auto-drain.
export class Transport {
  private serial = 0
  private closed = false
  private pending = new Map<number, {
    method: string
    resolve: (value: unknown) => void
    reject: (reason: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  private listeners = new Set<(event: Notification) => void>()
  private closeListeners = new Set<() => void>()
  private completion: Promise<void>

  private constructor(private process: ChildProcessWithoutNullStreams, private timeoutMs: number, home: string) {
    this.completion = new Promise((resolve) => process.once("close", () => {
      leases.delete(home)
      resolve()
    }))
    createInterface({ input: process.stdout }).on("line", (line) => {
      try {
        this.receive(JSON.parse(line))
      } catch {
        this.fail()
        process.kill()
      }
    })
    // Drain without retaining potentially sensitive native diagnostics.
    process.stderr.resume()
    process.on("error", () => this.fail())
    process.on("exit", () => this.fail())
    process.stdin.on("error", () => this.fail())
  }

  static async open(options: Launch) {
    await verifyProfile(options.profile)
    if (!path.isAbsolute(options.executable)) throw new Error("Native executable must be an absolute path")
    if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120000)) {
      throw new Error("Invalid native response deadline")
    }
    const env: Record<string, string> = {}
    for (const key of ["SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP"]) {
      const source = Object.keys(process.env).find((x) => x.toUpperCase() === key.toUpperCase())
      if (source && process.env[source]) env[key] = process.env[source]
    }
    Object.assign(env, {
      HOME: options.profile.home, USERPROFILE: options.profile.home,
      APPDATA: options.profile.home, LOCALAPPDATA: options.profile.home,
      CODEX_HOME: options.profile.home, RUST_LOG: "error",
      PATH: path.dirname(options.executable),
      DO_NOT_TRACK: "1",
    })
    if (options.profile.keyName && options.apiKey) env[options.profile.keyName] = options.apiKey
    const version = spawnSync(options.executable, ["--version"], { env, windowsHide: true, encoding: "utf8", timeout: 10000 })
    if (version.status !== 0 || version.stdout.trim() !== verifiedVersion) {
      throw new Error("Codex version is not verified; entry remains disabled")
    }
    if (leases.has(options.profile.home)) throw new Error("Native profile is already open in this application process")
    leases.add(options.profile.home)
    const args = ["app-server", "--stdio", ...Object.entries(policy).flatMap(([key, value]) => ["-c", `${key}=${value}`])]
    const child = spawn(options.executable, args, { env, cwd: options.profile.workspace, windowsHide: true, stdio: "pipe" })
    const transport = new Transport(child, options.timeoutMs ?? 30000, options.profile.home)
    try {
      const result = await transport.request<{ codexHome: string }>("initialize", {
        clientInfo: { name: "im_assistant_codex", version: "0.0.0" }, capabilities: { experimentalApi: true },
      })
      if (path.resolve(result.codexHome) !== options.profile.home) throw new Error("Unexpected native home")
      transport.write({ method: "initialized", params: {} })
      return transport
    } catch (error) {
      await transport.close()
      throw error
    }
  }

  subscribe(listener: (event: Notification) => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  onClose(listener: () => void) {
    if (this.closed) listener()
    else this.closeListeners.add(listener)
    return () => { this.closeListeners.delete(listener) }
  }

  request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (this.closed) return Promise.reject(new OutcomeUnknown(method))
    return new Promise((resolve, reject) => {
      const id = ++this.serial
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new OutcomeUnknown(method))
      }, this.timeoutMs)
      this.pending.set(id, { method, resolve: (value) => resolve(value as T), reject, timer })
      this.write({ id, method, params })
    })
  }

  private write(message: object) {
    if (!this.closed) this.process.stdin.write(JSON.stringify(message) + "\n")
  }

  private receive(message: { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string } }) {
    if (message.method && message.id !== undefined) {
      // Never approve tools/commands or execute server-requested tools in the host.
      this.write({ id: message.id, error: { code: -32601, message: "Host capability unavailable" } })
      return
    }
    if (message.id !== undefined) {
      const pending = typeof message.id === "number" ? this.pending.get(message.id) : undefined
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id as number)
      if (message.error) pending.reject(new NativeError(message.error.code, message.error.message))
      else pending.resolve(message.result)
      return
    }
    if (message.method) {
      for (const listener of this.listeners) {
        try { listener({ method: message.method, params: message.params ?? {} }) } catch { /* Subscribers do not own native execution. */ }
      }
    }
  }

  private fail() {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new OutcomeUnknown(pending.method))
    }
    this.pending.clear()
    this.listeners.clear()
    for (const listener of this.closeListeners) {
      try { listener() } catch { /* Lifecycle listeners cannot stop process cleanup. */ }
    }
    this.closeListeners.clear()
  }

  async close() {
    const exited = this.process.exitCode !== null || this.process.signalCode !== null
    this.fail()
    if (!exited && this.process.pid !== undefined) this.process.kill()
    await this.completion
  }
}
