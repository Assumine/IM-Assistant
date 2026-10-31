import { spawnSync } from "node:child_process"
import path from "node:path"
import { verifiedVersion, verifyProfile, type Profile } from "./profile"
import type { Connection } from "./connection"

export interface Launch {
  executable: string
  profile: Profile
  apiKey?: string
  timeoutMs?: number
}
export async function environment(options: Launch) {
  await verifyProfile(options.profile)
  if (!path.isAbsolute(options.executable)) throw new Error("Native executable must be an absolute path")
  if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120000)) throw new Error("Invalid native response deadline")
  const env: Record<string, string> = {}
  for (const key of ["SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP"]) {
    const source = Object.keys(process.env).find((name) => name.toUpperCase() === key.toUpperCase())
    if (source && process.env[source]) env[key] = process.env[source]
  }
  Object.assign(env, {
    HOME: options.profile.home, USERPROFILE: options.profile.home, APPDATA: options.profile.home,
    LOCALAPPDATA: options.profile.home, CODEX_HOME: options.profile.home, RUST_LOG: "error",
    PATH: path.dirname(options.executable), DO_NOT_TRACK: "1",
  })
  if (options.profile.keyName && options.apiKey) env[options.profile.keyName] = options.apiKey
  const version = spawnSync(options.executable, ["--version"], { env, windowsHide: true, encoding: "utf8", timeout: 10000 })
  if (version.status !== 0 || version.stdout.trim() !== verifiedVersion) throw new Error("Codex version is not verified; entry remains disabled")
  return env
}
export async function initialize(connection: Connection, options: Launch) {
  const result = await connection.request<{ codexHome: string; userAgent: string }>("initialize", {
    clientInfo: { name: "im_assistant_codex", version: "0.0.0" }, capabilities: { experimentalApi: true },
  })
  if (path.resolve(result.codexHome) !== options.profile.home ||
    !result.userAgent.startsWith(`im_assistant_codex/${verifiedVersion.replace("codex-cli ", "")} `)) {
    throw new Error("Native service identity differs; connection refused")
  }
  connection.write({ method: "initialized", params: {} })
}
