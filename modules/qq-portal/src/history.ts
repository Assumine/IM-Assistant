import { createHash } from "node:crypto"
import type { StorageDomain } from "../../../opencode/packages/plugin/src/promise/storage"
import { originKey, type Policy, type Scope } from "./routing"

export type HistoryConfig = { provider: "napcat"; pageSize: number; maxPages: number }
export type HistoricalInput = { sentAt: number; recoveredAt: number }
export type HistoryCursor = { scope: Scope; messageID: string; sequence: string; sentAt: number }
export type HistoryEntry = HistoryCursor & { raw: Record<string, unknown> }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const account = (value: unknown) => (typeof value === "string" || typeof value === "number" && Number.isSafeInteger(value)) && /^[1-9][0-9]{0,19}$/.test(String(value)) ? String(value) : undefined
const messageID = (value: unknown) => (typeof value === "string" || typeof value === "number" && Number.isSafeInteger(value)) && /^-?(?:0|[1-9][0-9]{0,19})$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? String(value) : undefined
const sequence = (value: unknown): value is string => typeof value === "string" && /^(?:0|[1-9][0-9]{0,39})$/.test(value)
const millis = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")

export function historicalInput(value: unknown): HistoricalInput | undefined {
  if (value === undefined) return undefined
  if (!record(value) || Object.keys(value).length !== 2 || !millis(value.sentAt) || !millis(value.recoveredAt)) throw new Error("Invalid historical input context")
  return { sentAt: value.sentAt, recoveredAt: value.recoveredAt }
}

export function historicalText(text: string, input?: HistoricalInput) {
  if (!input) return text
  return "[补收的历史留言，原发送时间：" + new Date(input.sentAt).toISOString() + "；补收时间：" + new Date(input.recoveredAt).toISOString() +
    "。这是历史消息；相对时间按原发送时间理解，已过期预约不要立即执行，时效或意图不清时先询问。]\n" + text
}

export function historyConfiguration(value: unknown): HistoryConfig | undefined {
  if (value === undefined) return undefined
  if (!record(value) || value.provider !== "napcat" || Object.keys(value).some((key) => !["provider", "pageSize", "maxPages"].includes(key))) throw new Error("Invalid QQ history configuration")
  const pageSize = value.pageSize ?? 100, maxPages = value.maxPages ?? 10
  if (typeof pageSize !== "number" || !Number.isSafeInteger(pageSize) || pageSize < 2 || pageSize > 100 ||
    typeof maxPages !== "number" || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 20 || pageSize * maxPages > 1000) throw new Error("Invalid QQ history bounds")
  return { provider: "napcat", pageSize, maxPages }
}

/** Transport checkpoints only. Bodies remain upstream until native admission; there is no executable spool. */
export function createHistory(options: {
  storage: Pick<StorageDomain, "get" | "set" | "scan">; policy: Policy; config: HistoryConfig
  read: (scope: Scope, before: string | undefined, count: number) => Promise<unknown[] | undefined>
}) {
  const { storage, policy, config } = options
  const prefix = "history:cursor:" + policy.botID + ":"
  const key = (scope: Scope) => prefix + scope.kind + ":" + scope.peerID
  const allowed = (scope: Scope) => scope.botID === policy.botID && (scope.kind === "private" ? policy.allowedUsers.includes(scope.peerID) : policy.allowedGroups.includes(scope.peerID))
  const cursor = async (scope: Scope): Promise<HistoryCursor | undefined> => {
    const value = await storage.get(key(scope))
    if (value === undefined) return undefined
    if (!record(value) || value.version !== 1 || !record(value.scope) || value.scope.botID !== scope.botID || value.scope.kind !== scope.kind || value.scope.peerID !== scope.peerID ||
      !messageID(value.messageID) || !sequence(value.sequence) || !millis(value.sentAt)) throw new Error("Invalid QQ history cursor")
    return { scope, messageID: String(value.messageID), sequence: value.sequence, sentAt: value.sentAt }
  }
  const entry = (value: unknown, expected?: Scope): HistoryEntry | undefined => {
    if (!record(value) || value.self_id !== undefined && account(value.self_id) !== policy.botID ||
      value.message_type !== "private" && value.message_type !== "group" || ![undefined, "message", "message_sent"].includes(value.post_type as string | undefined)) return undefined
    const actorID = account(value.user_id), id = messageID(value.message_id)
    const peerID = value.message_type === "group" ? account(value.group_id) : actorID === policy.botID ? expected?.peerID ?? account(value.target_id) : actorID
    if (!actorID || !peerID || !id || !sequence(value.real_seq) || typeof value.time !== "number" || !Number.isSafeInteger(value.time) || value.time <= 0 || value.time >= 100000000000) return undefined
    const scope: Scope = { botID: policy.botID, kind: value.message_type, peerID }
    if (!allowed(scope) || expected && (scope.kind !== expected.kind || scope.peerID !== expected.peerID || scope.botID !== expected.botID)) return undefined
    if (scope.kind === "private" && actorID === policy.botID && value.target_id !== undefined && account(value.target_id) !== scope.peerID) return undefined
    return { scope, messageID: id, sequence: value.real_seq, sentAt: value.time * 1000,
      raw: { ...value, self_id: policy.botID, post_type: value.post_type ?? (actorID === policy.botID ? "message_sent" : "message") } }
  }
  return {
    entry,
    async scopes() {
      const scopes: Scope[] = [], cursors = new Set<string>()
      let after: string | undefined
      do {
        const page = await storage.scan({ prefix, after, limit: 100 })
        for (const row of page.entries) {
          const match = /^(private|group):([1-9][0-9]{0,19})$/.exec(row.key.slice(prefix.length))
          if (!row.key.startsWith(prefix) || !match) throw new Error("Invalid QQ history scope")
          const scope: Scope = { botID: policy.botID, kind: match[1] as Scope["kind"], peerID: match[2] }
          if (allowed(scope)) scopes.push(scope)
        }
        after = page.next
        if (after && cursors.has(after)) throw new Error("Repeated QQ history scope cursor")
        if (after) cursors.add(after)
      } while (after)
      return scopes
    },
    async check(value: HistoryEntry) {
      const old = await cursor(value.scope)
      if (old && value.sequence === old.sequence && (value.messageID !== old.messageID || value.sentAt !== old.sentAt)) throw new Error("Different QQ history boundary")
      // Previously seen input without a retained origin, proposal or explicit refusal is uncertain,
      // not permission to guess a fresh target after rebinding. The original portal owns each receipt.
      const origin = originKey(value.scope, value.messageID)
      const ingress = await storage.get("ingress:" + origin)
      if (!record(ingress) || ingress.kind !== "input") return
      const [input, proposal, refusal] = await Promise.all([storage.get("origin:" + origin), storage.get("confirmation:" + origin), storage.get("input-refusal:" + origin)])
      if (input === undefined && proposal === undefined && refusal === undefined) throw new Error("QQ history admission evidence unavailable")
    },
    async commit(value: HistoryEntry, verifiedHistory = false) {
      const old = await cursor(value.scope)
      if (old && BigInt(value.sequence) <= BigInt(old.sequence)) {
        if (value.sequence === old.sequence && (value.messageID !== old.messageID || value.sentAt !== old.sentAt)) throw new Error("Different QQ history boundary")
        return
      }
      // Live streams can omit outgoing/system messages or deliver late. Only a contiguous observation or
      // a completed history scan proves a newer recovery boundary; a jump cannot hide missing inputs.
      if (old && !verifiedHistory && BigInt(value.sequence) !== BigInt(old.sequence) + 1n) return
      await storage.set(key(value.scope), { version: 1, scope: value.scope, messageID: value.messageID, sequence: value.sequence, sentAt: value.sentAt })
    },
    async collect(scope: Scope): Promise<HistoryEntry[]> {
      const boundary = await cursor(scope)
      if (!boundary || !allowed(scope)) return []
      const rows = new Map<string, HistoryEntry>(), proofs = new Map<string, string>(), identities = new Map<string, string>(), anchors = new Set<string>()
      let before: string | undefined
      let ceiling: string | undefined
      for (let page = 0; page < config.maxPages; page++) {
        const data = await options.read(scope, before, config.pageSize)
        if (!data?.length || data.length > config.pageSize) throw new Error("QQ history boundary unavailable")
        const entries = data.map((raw) => entry(raw, scope))
        if (entries.some((row) => !row)) throw new Error("Unproven QQ history entry")
        const ordered = entries.filter((row): row is HistoryEntry => !!row).sort((a, b) => BigInt(a.sequence) < BigInt(b.sequence) ? -1 : BigInt(a.sequence) > BigInt(b.sequence) ? 1 : 0)
        for (const row of ordered) {
          if (ceiling !== undefined && BigInt(row.sequence) > BigInt(ceiling)) throw new Error("QQ history page advanced past its anchor")
          if (identities.has(row.messageID) && identities.get(row.messageID) !== row.sequence) throw new Error("Reused QQ history message ID")
          identities.set(row.messageID, row.sequence)
          const proof = digest([row.messageID, row.sentAt, row.raw.user_id, row.raw.message, row.raw.post_type])
          if (proofs.has(row.sequence) && proofs.get(row.sequence) !== proof) throw new Error("Conflicting QQ history sequence")
          proofs.set(row.sequence, proof)
          if (BigInt(row.sequence) > BigInt(boundary.sequence)) rows.set(row.sequence, row)
        }
        const found = ordered.find((row) => row.sequence === boundary.sequence)
        if (found) {
          if (found.messageID !== boundary.messageID || found.sentAt !== boundary.sentAt) throw new Error("Different QQ history boundary")
          return [...rows.values()].sort((a, b) => BigInt(a.sequence) < BigInt(b.sequence) ? -1 : 1)
        }
        const oldest = ordered[0]!
        if (BigInt(oldest.sequence) < BigInt(boundary.sequence) || anchors.has(oldest.messageID)) throw new Error("QQ history gap")
        anchors.add(oldest.messageID); before = oldest.messageID; ceiling = oldest.sequence
      }
      throw new Error("QQ history recovery limit")
    },
  }
}
