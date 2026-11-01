import { createHash } from "node:crypto"
import type { StorageDomain } from "../../../opencode/packages/plugin/src/promise/storage"
import { command, fingerprint, inputID, originKey, type Message, type Policy } from "./routing"
import type { ControlOptions, ControlResponse } from "./controls"
import type { Source } from "./sources"
import { target, type Target } from "./target"
import { isViewID } from "./views"
import type { SendResult } from "./onebot"
import { controlReply } from "./control-reply"

type Storage = Pick<StorageDomain, "get" | "insert">
type Intent = { version: 1; source: Source; fingerprint: string; action: string; bodyHash: string; viewID?: string; hash: string }
type Outcome = { version: 1; hash: string } & (SendResult | { status: "forbidden" })
export type NotificationReceipt =
  | { status: "sent"; messageID: string; linkage: "linked" | "unlinked" | "not-required" | "not-checked"; duplicate: boolean }
  | { status: "missing" | "ignored" | "forbidden" | "unavailable" | "rejected" | "uncertain" | "conflict"; duplicate?: boolean }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const numericID = (value: unknown): value is string => typeof value === "string" && /^-?(?:0|[1-9][0-9]{0,19})$/.test(value) && Number.isSafeInteger(Number(value))
const identity = (value: Source) => [value.scope.botID, value.scope.kind, value.scope.peerID, value.actorID, value.messageID]
const same = (a: Source, b: Source) => JSON.stringify(identity(a)) === JSON.stringify(identity(b))
const intentHash = (value: Omit<Intent, "hash">) => hash([1, identity(value.source), value.fingerprint, value.action, value.bodyHash, value.viewID ?? null])
const source = (value: unknown): Source => {
  if (!record(value) || Object.keys(value).length !== 3 || !record(value.scope) || Object.keys(value.scope).length !== 3 || typeof value.scope.botID !== "string" || !/^[1-9][0-9]{0,19}$/.test(value.scope.botID) ||
    typeof value.scope.peerID !== "string" || !/^[1-9][0-9]{0,19}$/.test(value.scope.peerID) || value.scope.kind !== "private" && value.scope.kind !== "group" ||
    typeof value.actorID !== "string" || !/^[1-9][0-9]{0,19}$/.test(value.actorID) || value.actorID === value.scope.botID ||
    typeof value.messageID !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value.messageID) || value.scope.kind === "private" && value.scope.peerID !== value.actorID)
    throw new Error("Invalid QQ notification source")
  return { scope: { botID: value.scope.botID, kind: value.scope.kind, peerID: value.scope.peerID }, actorID: value.actorID, messageID: value.messageID }
}
const parse = (value: unknown): Intent => {
  if (!record(value) || value.version !== 1 || !digest(value.fingerprint) || !digest(value.bodyHash) || !digest(value.hash) ||
    typeof value.action !== "string" || !/^[a-z][\w-]*$/.test(value.action) || value.viewID !== undefined && !isViewID(value.viewID) ||
    Object.keys(value).some((key) => !["version", "source", "fingerprint", "action", "bodyHash", "viewID", "hash"].includes(key))) throw new Error("Invalid notification intent")
  const result: Intent = { version: 1, source: source(value.source), fingerprint: value.fingerprint, action: value.action,
    bodyHash: value.bodyHash, ...(value.viewID ? { viewID: value.viewID as string } : {}), hash: value.hash }
  if (intentHash(result) !== result.hash) throw new Error("Conflicting notification intent")
  return result
}

/** Notification metadata only: no response bodies, model context, task execution state, retry loop or executable outbox. */
export function createControlReplies(options: {
  storage: Storage; policy: Policy; permissions: ControlOptions
  send: (source: Source, text: string) => Promise<SendResult | { status: "forbidden" }>
  publish: (source: Source, viewID: string, outgoingID: string) => Promise<void>
}) {
  const { storage, policy, permissions } = options
  const permitted = (value: Source) => value.scope.botID === policy.botID && policy.allowedUsers.includes(value.actorID) &&
    (value.scope.kind === "private" || policy.allowedGroups.includes(value.scope.peerID))
  const key = (value: Source) => "notification:control:" + originKey(value.scope, value.messageID)
  const receiptKey = (value: Source) => "notification-receipt:control:" + originKey(value.scope, value.messageID)
  const allowedTarget = (value: Target) => value.kind === "session" || !!permissions.backendIDs?.includes(value.ref.backendID)
  const read = async (value: Intent): Promise<NotificationReceipt> => {
    const receipt = await storage.get(receiptKey(value.source))
    if (!record(receipt) || receipt.version !== 1 || receipt.hash !== value.hash) return { status: "uncertain" }
    if (receipt.status === "sent") return numericID(receipt.messageID) ? { status: "sent", messageID: receipt.messageID, linkage: "not-checked", duplicate: true } : { status: "uncertain" }
    return receipt.status === "unavailable" || receipt.status === "rejected" || receipt.status === "uncertain" || receipt.status === "forbidden" ? { status: receipt.status, duplicate: true } : { status: "uncertain" }
  }
  const finish = async (value: Intent, duplicate: boolean): Promise<NotificationReceipt> => {
    const receipt = await read(value)
    if (receipt.status !== "sent") return { ...receipt, duplicate }
    if (!value.viewID) return { ...receipt, duplicate, linkage: "not-required" }
    try { await options.publish(value.source, value.viewID, receipt.messageID); return { ...receipt, duplicate, linkage: "linked" } }
    catch { return { ...receipt, duplicate, linkage: "unlinked" } }
  }
  return {
    /** Read existing notification facts only. Missing or uncertain facts never authorize another send or task execution. */
    async inspect(entry: Source): Promise<NotificationReceipt> {
      try {
        const value = source(entry)
        if (!permitted(value)) return { status: "forbidden" }
        const cached = await storage.get(key(value))
        if (cached === undefined) return { status: (await storage.get(receiptKey(value))) === undefined ? "missing" : "uncertain" }
        const intent = parse(cached)
        if (!same(intent.source, value)) return { status: "conflict" }
        return await read(intent)
      } catch { return { status: "uncertain" } }
    },
    /** Trusted admission callback only. A first durable intent permits one wire attempt; duplicates reconcile/repair metadata only. */
    async deliver(input: Message, response: ControlResponse): Promise<NotificationReceipt> {
      try {
        const entry = source({ scope: input.scope, actorID: input.actorID, messageID: input.messageID })
        if (!permitted(entry)) return { status: "forbidden" }
        if (entry.scope.kind === "group" && !input.mentions.includes(policy.botID)) return { status: "ignored" }
        const action = command(input.text)?.action
        if (!action || response.action !== action || response.commandID !== inputID(input)) return { status: "conflict" }
        if (!permissions.allowedUsers.includes(entry.actorID) && response.result.kind !== "forbidden") return { status: "forbidden" }
        const ingress = await storage.get("ingress:" + originKey(input.scope, input.messageID))
        if (!record(ingress) || ingress.kind !== "control" || ingress.fingerprint !== fingerprint(input)) return { status: "conflict" }
        const old = await storage.get(key(entry))
        if (old !== undefined) {
          const value = parse(old)
          if (!same(value.source, entry) || value.fingerprint !== fingerprint(input) || value.action !== action) return { status: "conflict" }
          return await finish(value, true)
        }
        // A partial restore must not turn an existing send receipt into permission for a fresh wire attempt.
        if (await storage.get(receiptKey(entry)) !== undefined) return { status: "uncertain" }
        const result = response.result
        if ("target" in result && !allowedTarget(target(result.target)) || result.kind === "conversations" && result.items.some((row) => !allowedTarget(target(row.target)))) return { status: "forbidden" }
        const rendered = controlReply(response)
        if (rendered.viewID && !isViewID(rendered.viewID)) return { status: "conflict" }
        const content = { version: 1 as const, source: entry, fingerprint: fingerprint(input), action, bodyHash: hash(rendered.text), ...(rendered.viewID ? { viewID: rendered.viewID } : {}) }
        const value: Intent = { ...content, hash: intentHash(content) }
        if (!(await storage.insert(key(entry), value))) {
          const winner = parse(await storage.get(key(entry)))
          if (!same(winner.source, entry) || winner.fingerprint !== value.fingerprint || winner.action !== value.action) return { status: "conflict" }
          return await finish(winner, true)
        }
        let sent: SendResult | { status: "forbidden" }
        try { sent = await options.send(entry, rendered.text) } catch { sent = { status: "uncertain" } }
        const outcome: Outcome = { version: 1, hash: value.hash, ...sent }
        try { await storage.insert(receiptKey(entry), outcome) } catch { /* Read-only reconciliation below; never repeat the wire operation. */ }
        return await finish(value, false)
      } catch { return { status: "uncertain" } }
    },
  }
}
