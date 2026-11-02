import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises"
import path from "node:path"
import { Flock } from "../../../opencode/packages/util/src/flock"
import type { ApplicationModuleSettings } from "../../../opencode/packages/plugin/src/promise/application"
import { inlineImage, maximumImageBytes } from "../../qq-protocol/src/index"
import { configuration } from "./configuration"
import { accountID, policy, record, type ChatPolicy } from "./policy"
import type { Account } from "./types"
import type { Sticker } from "./replies"

export type ChatAccountSettings = Account & { enabled: boolean; url: string; tokenEnv: string; policy: Required<ChatPolicy>;
  contextGeneration: number; images?: { maxBytes: number }; stickers?: Sticker[] }
export type ChatSettings = { version: 1; enabled: boolean; accounts: ChatAccountSettings[] }
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every((key) => allowed.includes(key))
const empty = (): ChatSettings => ({ version: 1, enabled: false, accounts: [] })
const serialize = (value: ChatSettings) => JSON.stringify(value, null, 2) + "\n"
const revision = (text: string) => createHash("sha256").update(text).digest("hex")
const profile = (account: Account) => JSON.stringify([account.model, account.agentID, account.persona])

/** Only declarative settings. API credentials stay with native providers; QQ tokens are environment references. */
export function settings(value: unknown): ChatSettings {
  if (!record(value) || !keys(value, ["version", "enabled", "accounts"]) || value.version !== 1 || typeof value.enabled !== "boolean" ||
    !Array.isArray(value.accounts) || value.accounts.length > 8) throw new Error("Invalid QQ chat settings")
  const bots = new Set<string>(), tokens = new Set<string>()
  const accounts = value.accounts.map((item): ChatAccountSettings => {
    if (!record(item) || !keys(item, ["enabled", "botID", "url", "tokenEnv", "model", "agentID", "persona", "policy", "images", "stickers", "contextGeneration"]) ||
      item.enabled !== undefined && typeof item.enabled !== "boolean" || !record(item.model) || !keys(item.model, ["providerID", "id", "variant"]) ||
      !record(item.persona) || !keys(item.persona, ["name", "prompt"]) || !record(item.policy) ||
      !keys(item.policy, ["privateUsers", "groups", "groupReplies", "repliesEnabled", "ignoredUsers"]) ||
      typeof item.url !== "string" || typeof item.tokenEnv !== "string" || !/^IM_QQ_CHAT_TOKEN_[A-Z0-9_]{1,64}$/.test(item.tokenEnv))
      throw new Error("Invalid QQ chat account settings")
    const account = configuration({ location: { directory: path.resolve(".") }, accounts: [item as unknown as Account] }).accounts[0]!
    if (bots.has(account.botID) || tokens.has(item.tokenEnv)) throw new Error("Duplicate QQ chat account settings")
    const rules = policy(item.policy as ChatPolicy)
    if (![account.botID, ...rules.privateUsers, ...rules.groups, ...rules.ignoredUsers].every((id) => accountID(id) && Number.isSafeInteger(Number(id))))
      throw new Error("Invalid QQ chat identity")
    const url = new URL(item.url)
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || !["ws:", "wss:"].includes(url.protocol) ||
      url.protocol === "ws:" && !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) throw new Error("Invalid QQ chat endpoint")
    if (item.images !== undefined && (!record(item.images) || !keys(item.images, ["maxBytes"]) || !Number.isSafeInteger(item.images.maxBytes) ||
      typeof item.images.maxBytes !== "number" || item.images.maxBytes < 1 || item.images.maxBytes > maximumImageBytes)) throw new Error("Invalid QQ chat image budget")
    if (item.stickers !== undefined && (!Array.isArray(item.stickers) || item.stickers.length > 32 || item.stickers.some((sticker) =>
      !record(sticker) || !keys(sticker, ["id", "label", "uri"]) || typeof sticker.id !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(sticker.id) ||
      typeof sticker.label !== "string" || !sticker.label.trim() || sticker.label.length > 80 || typeof sticker.uri !== "string" || !inlineImage(sticker.uri, 2 * 1024 * 1024)) ||
      new Set(item.stickers.map((sticker: Sticker) => sticker.id)).size !== item.stickers.length)) throw new Error("Invalid QQ chat sticker settings")
    bots.add(account.botID); tokens.add(item.tokenEnv)
    return { ...account, enabled: item.enabled !== false, contextGeneration: account.contextGeneration ?? 0, url: url.href, tokenEnv: item.tokenEnv, policy: rules,
      ...(item.images ? { images: structuredClone(item.images) as { maxBytes: number } } : {}),
      ...(item.stickers ? { stickers: structuredClone(item.stickers) as Sticker[] } : {}) }
  })
  if (value.enabled && accounts.length === 0) throw new Error("Configure QQ chat accounts before enabling")
  const result: ChatSettings = { version: 1, enabled: value.enabled, accounts }
  if (Buffer.byteLength(serialize(result), "utf8") > 524288) throw new Error("QQ chat settings exceed the size limit")
  return result
}

export async function readSettings(home: string): Promise<ChatSettings> {
  try {
    const file = path.join(home, "channels.json")
    if (!(await lstat(file)).isFile()) throw new Error("QQ chat settings must be a regular file")
    const handle = await open(file, "r")
    try {
      const maximum = 524288, buffer = Buffer.alloc(maximum + 1)
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > maximum) throw new Error("QQ chat settings exceed the size limit")
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      if (bytesRead > maximum) throw new Error("QQ chat settings exceed the size limit")
      return settings(JSON.parse(buffer.toString("utf8", 0, bytesRead)))
    } finally { await handle.close() }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return empty()
    throw new Error("QQ chat settings are unavailable")
  }
}

/** Module-owned settings use the existing generic capability GUI/RPC, including when disabled. */
export function settingsOwner(home: string): ApplicationModuleSettings {
  const describe = (value: ChatSettings) => ({ revision: revision(serialize(value)), text: serialize(value), appliesTo: "next-service-start" as const,
    description: "Native provider/model references and QQ token environment names only. Increase contextGeneration explicitly when changing persona or model; old native histories remain available. Changes apply on the next service start." })
  return {
    async read(signal) { signal.throwIfAborted(); return describe(await readSettings(home)) },
    async write(input, signal) {
      if (input.text.length > 524288) throw new Error("QQ chat settings exceed the size limit")
      const desired = settings(JSON.parse(input.text))
      return Flock.withLock("qq-chat-settings", async () => {
        const previous = await readSettings(home)
        if (revision(serialize(previous)) !== input.revision) return undefined
        for (const account of desired.accounts) {
          const old = previous.accounts.find((item) => item.botID === account.botID)
          if (old && (account.contextGeneration < old.contextGeneration ||
            profile(old) !== profile(account) && account.contextGeneration === old.contextGeneration))
            throw new Error("Explicitly reset this chat account before changing its persona or model")
        }
        signal.throwIfAborted()
        const temporary = path.join(home, ".channels-" + randomUUID() + ".json")
        const file = await open(temporary, "wx", 0o600)
        try {
          await file.writeFile(serialize(desired)); await file.close()
          await rename(temporary, path.join(home, "channels.json"))
        } finally { await file.close(); await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error }) }
        return describe(desired)
      }, { dir: path.join(home, ".locks"), signal, timeoutMs: 2000 })
    },
  }
}

export async function initializeSettings(home: string) {
  await mkdir(home, { recursive: true })
  const file = await open(path.join(home, "channels.json"), "wx", 0o600)
  try { await file.writeFile(serialize(empty())) } finally { await file.close() }
}

export async function updateSettings(home: string, update: (previous: ChatSettings) => unknown) {
  const owner = settingsOwner(home), signal = new AbortController().signal
  const previous = await owner.read(signal)
  const result = await owner.write({ revision: previous.revision, text: JSON.stringify(update(settings(JSON.parse(previous.text)))) }, signal)
  if (!result) throw new Error("QQ chat settings changed; read them before trying again")
  return settings(JSON.parse(result.text))
}
