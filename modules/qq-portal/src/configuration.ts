import { lstat, mkdir, open, rename, unlink } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import type { Policy } from "./routing"
import type { ControlOptions } from "./controls"

export type Account = { policy: Policy; url: string; tokenEnv: string; controls?: ControlOptions }
export type Configuration = { version: 1; enabled: boolean; accounts: Account[] }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every((key) => allowed.includes(key))
const id = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value) && Number.isSafeInteger(Number(value))
const ids = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 1000 && value.every(id) && new Set(value).size === value.length

/** Only declarative channel metadata; credentials are never accepted in this file. */
export function configuration(value: unknown): Configuration {
  if (!record(value) || !keys(value, ["version", "enabled", "accounts"]) || value.version !== 1 || typeof value.enabled !== "boolean" ||
    !Array.isArray(value.accounts) || value.accounts.length > 8) throw new Error("Invalid QQ configuration")
  const bots = new Set<string>(), tokens = new Set<string>()
  const accounts = value.accounts.map((item): Account => {
    if (!record(item) || !keys(item, ["policy", "url", "tokenEnv", "controls"]) || !record(item.policy) ||
      !keys(item.policy, ["botID", "allowedUsers", "allowedGroups"]) || !id(item.policy.botID) || !ids(item.policy.allowedUsers) || !ids(item.policy.allowedGroups) ||
      typeof item.url !== "string" || typeof item.tokenEnv !== "string" || !/^IM_QQ_TOKEN_[A-Z0-9_]{1,64}$/.test(item.tokenEnv) ||
      bots.has(item.policy.botID) || tokens.has(item.tokenEnv)) throw new Error("Invalid QQ account configuration")
    const url = new URL(item.url)
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || !["ws:", "wss:"].includes(url.protocol) ||
      url.protocol === "ws:" && !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) throw new Error("Invalid QQ endpoint")
    const policy = { botID: item.policy.botID, allowedUsers: [...item.policy.allowedUsers], allowedGroups: [...item.policy.allowedGroups] }
    let permissions: ControlOptions | undefined
    const controls = item.controls
    if (controls !== undefined) {
      if (!record(controls) || !keys(controls, ["allowedUsers", "backendIDs"]) || !ids(controls.allowedUsers) ||
        !controls.allowedUsers.every((user) => policy.allowedUsers.includes(user))) throw new Error("Invalid QQ control permissions")
      const backends = controls.backendIDs
      if (backends !== undefined && (!Array.isArray(backends) || backends.length > 32 ||
        !backends.every((value): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value) && value !== "opencode") ||
        new Set(backends).size !== backends.length)) throw new Error("Invalid QQ backend permissions")
      permissions = { allowedUsers: [...controls.allowedUsers], ...(backends ? { backendIDs: [...backends] } : {}) }
    }
    bots.add(item.policy.botID); tokens.add(item.tokenEnv)
    return { policy, url: url.href, tokenEnv: item.tokenEnv, ...(permissions ? { controls: permissions } : {}) }
  })
  if (value.enabled && accounts.length === 0) throw new Error("QQ accounts must be configured before enabling")
  return { version: 1, enabled: value.enabled, accounts }
}

export async function readConfiguration(home: string): Promise<Configuration> {
  try {
    const location = path.join(home, "channels.json")
    if (!(await lstat(location)).isFile()) throw new Error("QQ settings must be a regular file")
    const file = await open(location, "r")
    try {
      const stat = await file.stat(), maximum = 524288
      if (!stat.isFile() || stat.size > maximum) throw new Error("QQ settings exceed their size limit")
      const buffer = Buffer.alloc(maximum + 1)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      if (bytesRead > maximum) throw new Error("QQ settings exceed their size limit")
      return configuration(JSON.parse(buffer.toString("utf8", 0, bytesRead)))
    } finally { await file.close() }
  }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { version: 1, enabled: false, accounts: [] }
    throw new Error("QQ configuration is unavailable")
  }
}

export async function initialize(home: string) {
  await mkdir(home, { recursive: true })
  const file = await open(path.join(home, "channels.json"), "wx", 0o600)
  try { await file.writeFile(JSON.stringify({ version: 1, enabled: false, accounts: [] }, null, 2) + "\n") }
  finally { await file.close() }
}

export async function setEnabled(home: string, enabled: boolean) {
  const previous = await readConfiguration(home)
  const value = configuration({ ...previous, enabled })
  if (previous.enabled === enabled) return
  const temporary = path.join(home, ".channels-" + randomUUID() + ".json")
  const file = await open(temporary, "wx", 0o600)
  try { await file.writeFile(JSON.stringify(value, null, 2) + "\n"); await file.close(); await rename(temporary, path.join(home, "channels.json")) }
  finally { await file.close(); await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error }) }
}
