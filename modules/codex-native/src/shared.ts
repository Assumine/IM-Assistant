import { spawn } from "node:child_process"
import { createConnection } from "node:net"
import { readFile } from "node:fs/promises"
import { Connection } from "./connection"
import { environment, initialize, type Launch } from "./launch"
import { policy } from "./profile"

async function connect(options: Launch) {
  if (typeof Bun === "undefined") throw new Error("Shared native transport requires the pinned Bun host")
  const service = options.profile.service!
  const token = await readFile(service.tokenFile, "utf8")
  // lib.dom hides Bun's authenticated client overload; this path explicitly requires Bun.
  const Client = WebSocket as typeof WebSocket & { new(url: string, options: Bun.WebSocketOptions): WebSocket }
  const socket = new Client(`ws://127.0.0.1:${service.port}`, { headers: { Authorization: `Bearer ${token}` } })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error("Native connection deadline exceeded")) }, 1000)
    socket.addEventListener("open", () => { clearTimeout(timer); resolve() }, { once: true })
    socket.addEventListener("error", () => { clearTimeout(timer); socket.close(); reject(new Error("Local native service is unavailable")) }, { once: true })
  })
  return new Connection({
    send: (text) => { socket.send(text) },
    listen: (message, closed) => {
      socket.addEventListener("message", (event) => message(String(event.data)))
      socket.addEventListener("error", closed)
      socket.addEventListener("close", closed)
      if (socket.readyState !== WebSocket.OPEN) closed()
    },
    close: () => new Promise<void>((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) { resolve(); return }
      socket.addEventListener("close", () => resolve(), { once: true })
      socket.close()
    }),
  }, options.timeoutMs ?? 30000)
}

async function verify(connection: Connection, options: Launch) {
  await initialize(connection, options)
  const response = await connection.request<{ config: Record<string, unknown>; layers?: { config: Record<string, unknown> }[] }>("config/read", { includeLayers: true })
  for (const [key, expected] of Object.entries(policy)) {
    const lookup = (config: Record<string, unknown>) => key.split(".").reduce<unknown>((value, field) =>
      value && typeof value === "object" ? (value as Record<string, unknown>)[field] : undefined, config)
    // Config's typed view omits update_plan; native layers are returned highest-precedence first.
    const actual = [response.config, ...(response.layers ?? []).map((layer) => layer.config)].map(lookup).find((value) => value !== undefined)
    if (JSON.stringify(actual) !== expected) throw new Error(`Native service policy differs (${key}); connection refused`)
  }
  const info = await connection.request<{ process: { id: number } }>("server/diagnostics", {})
  if (!Number.isSafeInteger(info.process.id) || info.process.id < 1 || info.process.id === process.pid) throw new Error("Invalid native service identity")
  connection.setRuntime("shared", info.process.id)
  return connection
}

export async function openShared(options: Launch, env: Record<string, string>, start = true) {
  if (typeof Bun === "undefined") throw new Error("Shared native transport requires the pinned Bun host")
  if (!options.profile.service) throw new Error("A shared native profile is required")
  let connection = await connect(options).catch(() => undefined)
  let launched: ReturnType<typeof spawn> | undefined
  if (!connection && start) {
    // The native listener's OS bind is the exclusion mechanism, not a PID file or stale timer.
    // Racing contenders may start a losing CLI; only one can bind and execute requests.
    launched = spawn(options.executable, ["app-server", "--listen", `ws://127.0.0.1:${options.profile.service.port}`,
      "--ws-auth", "capability-token", "--ws-token-file", options.profile.service.tokenFile,
      ...Object.entries(policy).flatMap(([key, value]) => ["-c", `${key}=${value}`])], {
      env, cwd: options.profile.workspace, windowsHide: true, detached: true, stdio: "ignore",
    })
    launched.on("error", () => undefined)
    launched.unref()
    const deadline = Date.now() + 10000
    while (!connection && Date.now() < deadline) {
      connection = await connect(options).catch(() => undefined)
      if (!connection) await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  if (!connection) {
    if (launched?.exitCode === null) launched.kill()
    throw new Error("Native service unavailable; no requests were replayed")
  }
  try { return await verify(connection, options) } catch (error) {
    await connection.close()
    if (launched?.exitCode === null) launched.kill()
    throw error
  }
}

// Trusted host lifecycle action, deliberately absent from the model/GUI RPC surface.
export async function stopSharedService(options: Launch): Promise<{ status: "stopped" | "notRunning" }> {
  const env = await environment(options)
  if (!options.profile.service) throw new Error("A shared native profile is required")
  const connection = await openShared(options, env, false).catch(async (error) => {
    const listening = await new Promise<boolean>((resolve) => {
      const probe = createConnection({ host: "127.0.0.1", port: options.profile.service!.port })
      const finish = (value: boolean) => { probe.destroy(); resolve(value) }
      probe.once("connect", () => finish(true))
      probe.once("error", () => finish(false))
      probe.setTimeout(1000, () => finish(true))
    })
    if (listening) throw error
    return undefined
  })
  if (!connection) return { status: "notRunning" }
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Native service stop could not be confirmed")), 10000)
      connection.onClose(() => { clearTimeout(timer); resolve() })
      try { process.kill(connection.info().pid) } catch (error) { clearTimeout(timer); reject(error) }
    })
    return { status: "stopped" }
  } finally { await connection.close() }
}
