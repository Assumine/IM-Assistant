import type { ChatInput } from "./types"
import { imageFile } from "../../qq-protocol/src/index"

export type ChatPolicy = { privateUsers: readonly string[]; groups: readonly string[]; groupReplies?: "auto" | "directed" | "off"; repliesEnabled?: boolean; ignoredUsers?: readonly string[] }
export const accountID = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value)
export const messageID = (value: unknown): value is string => typeof value === "string" && /^-?(?:0|[1-9][0-9]{0,19})$/.test(value)
export const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const id = (value: unknown) => (typeof value === "string" || typeof value === "number" && Number.isSafeInteger(value)) && accountID(String(value)) ? String(value) : undefined
const message = (value: unknown) => (typeof value === "string" || typeof value === "number" && Number.isSafeInteger(value)) && messageID(String(value)) ? String(value) : undefined

export function policy(value: ChatPolicy): Required<ChatPolicy> {
  const list = (items: readonly string[]) => Array.isArray(items) && items.length <= 1000 && items.every(accountID) && new Set(items).size === items.length
  if (!value || !list(value.privateUsers) || !list(value.groups) || !list(value.ignoredUsers ?? []) ||
    value.groupReplies !== undefined && !["auto", "directed", "off"].includes(value.groupReplies) ||
    value.repliesEnabled !== undefined && typeof value.repliesEnabled !== "boolean") throw new Error("Invalid QQ chat policy")
  return { privateUsers: [...value.privateUsers], groups: [...value.groups], ignoredUsers: [...(value.ignoredUsers ?? [])],
    groupReplies: value.groupReplies ?? "auto", repliesEnabled: value.repliesEnabled ?? true }
}

/** Chat authorization deliberately does not import task commands, bindings or task @ rules. */
export function decode(value: unknown, botID: string, rules: Required<ChatPolicy>, bots: readonly string[]): ChatInput | "ignored" | "unsupported" {
  if (!record(value) || value.post_type !== "message" || id(value.self_id) !== botID || !["private", "group"].includes(String(value.message_type))) return "ignored"
  const actorID = id(value.user_id)
  if (!actorID || bots.includes(actorID) || rules.ignoredUsers.includes(actorID)) return "ignored"
  const kind = value.message_type as "private" | "group", peerID = kind === "private" ? actorID : id(value.group_id)
  if (!peerID || (kind === "private" ? !rules.privateUsers.includes(actorID) : !rules.groups.includes(peerID))) return "ignored"
  if (!message(value.message_id) || !Array.isArray(value.message) || value.message.length > 64 ||
    record(value.sender) && value.sender.user_id !== undefined && id(value.sender.user_id) !== actorID) return "unsupported"
  const parts: string[] = [], images: string[] = [], mentions: string[] = []
  let quoteID: string | undefined
  for (const part of value.message) {
    if (!record(part) || !record(part.data)) return "unsupported"
    if (part.type === "text" && typeof part.data.text === "string") parts.push(part.data.text)
    else if (part.type === "at" && String(part.data.qq) === "all") parts.push("[全体成员]")
    else if (part.type === "at" && id(part.data.qq)) mentions.push(String(part.data.qq))
    else if (part.type === "image" && imageFile(part.data.file)) images.push(part.data.file)
    else if (part.type === "face" && /^[0-9]{1,5}$/.test(String(part.data.id))) parts.push("[QQ表情 " + String(part.data.id) + "]")
    else if (part.type === "reply" && quoteID === undefined && message(part.data.id)) quoteID = String(part.data.id)
    else return "unsupported"
  }
  const text = parts.join("") || (images.length ? "[图片]" : mentions.length ? "[提及]" : "")
  if (!text.trim() || text.length > 16000 || images.length > 4 || mentions.length > 20 || text.includes("\0")) return "unsupported"
  const name = record(value.sender) ? value.sender.card || value.sender.nickname : undefined
  const displayName = typeof name === "string" ? name.replace(/\0/g, "").trim().slice(0, 80) : undefined
  return { scope: { botID, kind, peerID }, actorID, messageID: String(value.message_id), text,
    ...(displayName ? { displayName } : {}), ...(images.length ? { images } : {}),
    ...(mentions.length ? { mentions: [...new Set(mentions)] } : {}), ...(quoteID !== undefined ? { quoteID } : {}) }
}

export const directed = (input: ChatInput, name: string) => input.scope.kind === "private" ||
  !!input.mentions?.includes(input.scope.botID) || input.text.includes(name)
