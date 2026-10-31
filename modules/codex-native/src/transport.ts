import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { Connection } from "./connection"
import { environment, initialize, type Launch } from "./launch"
import { policy } from "./profile"
import { openShared } from "./shared"

export { NativeError, OutcomeUnknown } from "./connection"
export type { Notification } from "./connection"
export type { Launch } from "./launch"

const leases = new Set<string>()

export class Transport {
  static async open(options: Launch): Promise<Connection> {
    const env = await environment(options)
    if (options.profile.service) return openShared(options, env)
    // Legacy isolated stdio validation only. The shared profile uses native socket ownership.
    if (leases.has(options.profile.home)) throw new Error("Native profile is already open in this application process")
    leases.add(options.profile.home)
    const child = spawn(options.executable, ["app-server", "--stdio", ...Object.entries(policy).flatMap(([key, value]) => ["-c", `${key}=${value}`])], {
      env, cwd: options.profile.workspace, windowsHide: true, stdio: "pipe",
    })
    const completion = new Promise<void>((resolve) => child.once("close", () => {
      leases.delete(options.profile.home)
      resolve()
    }))
    const connection = new Connection({
      send: (text) => { child.stdin.write(text + "\n") },
      close: async () => {
        if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill()
        await completion
      },
      listen: (message, closed) => {
        createInterface({ input: child.stdout }).on("line", message)
        child.stderr.resume()
        child.on("error", closed)
        child.on("exit", closed)
        child.stdin.on("error", closed)
      },
    }, options.timeoutMs ?? 30000)
    try {
      await initialize(connection, options)
      connection.setRuntime("stdio", child.pid!)
      return connection
    } catch (error) {
      await connection.close()
      throw error
    }
  }
}
