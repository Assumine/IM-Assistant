import { createHash } from "node:crypto"

export type Policy = { botID: string; allowedUsers: readonly string[]; allowedGroups: readonly string[] }
export type Scope = { botID: string; kind: "private" | "group"; peerID: string }
export type Message = { scope: Scope; actorID: string; messageID: string; text: string; quoteID?: string; mentions: string[] }
export type Recall = { scope: Scope; actorID: string; messageID: string }
type RecordValue = Record<string, unknown>
const record = (value: unknown): value is RecordValue => !!value && typeof value === "object" && !Array.isArray(value)
const user = (value: unknown) => typeof value === "string" || typeof value === "number" && Number.isSafeInteger(value)
  ? (/^[1-9][0-9]{0,19}$/.test(String(value)) ? String(value) : undefined) : undefined
const message = (value: unknown) => typeof value === "string" || typeof value === "number" && Number.isSafeInteger(value)
  ? (/^[A-Za-z0-9_-]{1,64}$/.test(String(value)) ? String(value) : undefined) : undefined

/** Decode trusted transport's OneBot event; raw user text is never parsed as CQ markup or protocol instructions. */
export function decode(value: unknown, policy: Policy): { kind: "message"; message: Message } | { kind: "recall"; recall: Recall } | { kind: "ignored" } | { kind: "unsupported" } {
  if (!record(value) || user(value.self_id) !== policy.botID) return { kind: "ignored" }
  const actorID = user(value.user_id)
  if (!actorID || actorID === policy.botID || !policy.allowedUsers.includes(actorID)) return { kind: "ignored" }
  if (value.post_type !== "message" && !(value.post_type === "notice" && ["friend_recall", "group_recall"].includes(String(value.notice_type)))) return { kind: "ignored" }
  const group = value.post_type === "notice" ? value.notice_type === "group_recall" : value.message_type === "group"
  const peerID = group ? user(value.group_id) : actorID
  if (!peerID || group && !policy.allowedGroups.includes(peerID)) return { kind: "ignored" }
  const scope: Scope = { botID: policy.botID, kind: group ? "group" : "private", peerID }
  const messageID = message(value.message_id)
  if (!messageID) return { kind: "unsupported" }
  if (value.post_type === "notice" && (value.notice_type === "friend_recall" || value.notice_type === "group_recall"))
    return { kind: "recall", recall: { scope, actorID, messageID } }
  if (value.post_type !== "message" || !["private", "group"].includes(String(value.message_type))) return { kind: "ignored" }
  if (!Array.isArray(value.message)) return { kind: "unsupported" }
  const parts: string[] = [], quotes: string[] = [], mentions: string[] = []
  for (const part of value.message) {
    if (!record(part) || !record(part.data)) return { kind: "unsupported" }
    if (part.type === "text" && typeof part.data.text === "string") { parts.push(part.data.text); continue }
    if (part.type === "reply") {
      const id = message(part.data.id)
      if (!id || quotes.length) return { kind: "unsupported" }
      quotes.push(id); continue
    }
    if (part.type === "at") {
      const id = user(part.data.qq)
      if (!id) return { kind: "unsupported" }
      mentions.push(id); continue
    }
    return { kind: "unsupported" }
  }
  if (group && !mentions.includes(policy.botID)) return { kind: "ignored" }
  const text = parts.join("")
  if (!text.trim()) return { kind: "unsupported" }
  return { kind: "message", message: { scope, actorID, messageID, text, quoteID: quotes[0], mentions } }
}

const commands = new Set(["list", "bind", "unbind", "queue", "unqueue", "stop", "status", "model", "account", "watch", "unwatch", "progress", "permissions", "permission", "history", "research", "search", "mijia", "reply", "zcode"])
export function command(text: string) {
  const input = text.trim()
  const match = /^(?:\/(?:codex\s+)?|codex\s+)([a-z][\w-]*)(?:\s+([\s\S]*))?$/i.exec(input)
  const action = match?.[1]?.toLowerCase()
  if (action && commands.has(action)) return { action, arguments: match?.[2] ?? "" }
  if (/^\/?codex$/i.test(input)) return { action: "help", arguments: "" }
  const bind = /^bind(?:\s+([\s\S]*))?$/i.exec(input)
  if (bind) return { action: "bind", arguments: bind[1] ?? "" }
  return undefined
}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
export const scopeKey = (scope: Scope) => hash([scope.botID, scope.kind, scope.peerID])
export const originKey = (scope: Scope, id: string) => hash([scope.botID, scope.kind, scope.peerID, id])
export const inputID = (event: Pick<Message, "scope" | "messageID">) => "msg_qq_" + originKey(event.scope, event.messageID)
export const fingerprint = (event: Message) => hash([event.actorID, event.text, event.quoteID ?? null, event.mentions])
