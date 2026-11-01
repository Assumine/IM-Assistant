import { createHash } from "node:crypto"
import type { PromptInput } from "../../../opencode/packages/schema/src/prompt-input"
import { fingerprint, imageFile, originKey, type Message, type Policy } from "./routing"
import { delivery } from "./delivery"
import type { StorageDomain } from "../../../opencode/packages/plugin/src/promise/storage"
import type { SendResult } from "./onebot"
import type { Source } from "./sources"
import type { Result } from "./index"
import type { NotificationReceipt } from "./notifications"

export type ImageConfig = { provider: "napcat"; maxBytes: number }
export { maximumImageBytes, imageFrameBytes } from "../../qq-protocol/src/index"
import { decodeImage, maximumImageBytes } from "../../qq-protocol/src/index"

export function imageConfiguration(value: unknown): ImageConfig | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid QQ image configuration")
  const row = value as Record<string, unknown>
  const maxBytes = row.maxBytes ?? maximumImageBytes
  if (Object.keys(row).some((key) => !["provider", "maxBytes"].includes(key)) || row.provider !== "napcat" ||
    typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > maximumImageBytes)
    throw new Error("Invalid QQ image configuration")
  return { provider: "napcat", maxBytes }
}

/** Bytes arrive only through the authenticated platform's get_image response. No URL fetch or local file access. */
export function createImages(options: { config: ImageConfig; read: (source: Message, file: string) => Promise<unknown> }) {
  const reads = new Set<Promise<void>>()
  return async (source: Message): Promise<PromptInput.FileAttachment[] | undefined> => {
    if (!source.images?.length || source.images.length > 4 || source.images.some((file) => !imageFile(file))) return undefined
    while (reads.size >= 2) await Promise.race(reads)
    const done = Promise.withResolvers<void>()
    reads.add(done.promise)
    try {
      const files: PromptInput.FileAttachment[] = []
      let total = 0
      for (const file of source.images) {
        const image = decodeImage(file, await options.read(source, file), options.config.maxBytes - total)
        if (!image) return undefined
        total += image.byteLength
        files.push({ uri: image.uri, source: { type: "inline" }, name: image.name })
      }
      return files
    } catch { return undefined }
    finally { reads.delete(done.promise); done.resolve() }
  }
}

/** A refusal is a delivery receipt, never a task or an instruction to retry a model call. */
export function createImageReplies(options: {
  policy: Policy; storage: Pick<StorageDomain, "get" | "insert">
  send: (source: Source, text: string) => Promise<SendResult | { status: "forbidden" }>
}) {
  const receipts = delivery(options)
  const text = {
    "attachment-disabled": "当前会话尚未启用图片输入，本条消息未提交。",
    "attachment-unavailable": "图片获取或校验失败，本条消息未提交。请重新发送图片。",
    "attachment-adjustment-unavailable": "这条引用补充暂不支持图片，本条消息未提交。请把图片作为新消息发送。",
  }
  return async (input: Message, result: Result): Promise<NotificationReceipt> => {
    if (!input.images?.length || result.status !== "blocked" || !(result.reason in text)) return { status: "ignored" }
    if (input.scope.botID !== options.policy.botID || !options.policy.allowedUsers.includes(input.actorID) ||
      (input.scope.kind === "private" ? input.scope.peerID !== input.actorID : !options.policy.allowedGroups.includes(input.scope.peerID))) return { status: "forbidden" }
    const reason = result.reason as keyof typeof text
    const hash = createHash("sha256").update(JSON.stringify([fingerprint(input), reason])).digest("hex")
    const key = "notification:attachment:" + originKey(input.scope, input.messageID), receipt = key + ":receipt"
    const value = { version: 1, hash }
    try {
      if (!await options.storage.insert(key, value)) return JSON.stringify(await options.storage.get(key)) === JSON.stringify(value)
        ? receipts.finish(receipt, hash, true) : { status: "conflict" }
      return await receipts.attempt(receipt, hash, input, text[reason])
    } catch { return { status: "uncertain" } }
  }
}
