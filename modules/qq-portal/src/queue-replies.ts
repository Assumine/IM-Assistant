import { createHash } from "node:crypto"
import type { OpenCodeClient } from "../../../opencode/packages/client/src/promise"
import type { StorageDomain } from "../../../opencode/packages/plugin/src/promise/storage"
import type { Native, Backend, Target, Withdrawal } from "./target"
import { target, sameTarget } from "./target"
import { source, sourceKey, type Source, type SourceResult } from "./sources"
import type { Policy } from "./routing"
import type { ControlOptions } from "./controls"
import type { SendResult, RecallResult } from "./onebot"
import type { NotificationReceipt } from "./notifications"
import { delivery } from "./delivery"

type Intent = { version: 1; target: Target; inputID: string; nativeID: string; source: Source; position: number; controls: boolean; hash: string }
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const digest = (value: Omit<Intent, "hash">) => hash([1, sourceKey(value.target, value.inputID), value.nativeID,
  value.source.scope.botID, value.source.scope.kind, value.source.scope.peerID, value.source.actorID, value.source.messageID, value.position, value.controls])

/** Queue notification receipts only. All position, delivery and cancellation facts come from the original backend. */
export function createQueueReplies(options: {
  policy: Policy; controls?: ControlOptions; storage: Pick<StorageDomain, "get" | "insert">
  session: Pick<Native, "get" | "inbox">; backend: Backend
  log: OpenCodeClient["experimental"]["session"]["log"]
  sourceFor: (target: Target, inputID: string) => Promise<SourceResult>
  linkReply: (source: Source, messageID: string) => Promise<void>
  send: (source: Source, text: string) => Promise<SendResult | { status: "forbidden" }>
  recall: (source: Source, messageID: string) => Promise<RecallResult>
}) {
  const { storage, policy } = options, receipts = delivery(options)
  const key = (destination: Target, inputID: string) => "notification:queue:" + sourceKey(destination, inputID)
  const allowed = (value: Source) => value.scope.botID === policy.botID && policy.allowedUsers.includes(value.actorID) &&
    (value.scope.kind === "private" ? value.scope.peerID === value.actorID : policy.allowedGroups.includes(value.scope.peerID))
  const parse = (raw: unknown, destination: Target, inputID: string): Intent => {
    if (!record(raw) || raw.version !== 1 || raw.inputID !== inputID || !id(raw.nativeID) || !sameTarget(target(raw.target), destination) ||
      typeof raw.position !== "number" || !Number.isSafeInteger(raw.position) || raw.position < 1 || typeof raw.controls !== "boolean") throw new Error("Invalid queue notification")
    const value = { version: 1 as const, target: destination, inputID, nativeID: raw.nativeID, source: source(raw.source), position: raw.position, controls: raw.controls }
    if (raw.hash !== digest(value)) throw new Error("Conflicting queue notification")
    return { ...value, hash: raw.hash }
  }
  const read = async (destination: Target, inputID: string) => {
    const value = await storage.get(key(destination, inputID))
    return value === undefined ? undefined : parse(value, destination, inputID)
  }
  const pending = async (destination: Target, inputID: string): Promise<{ nativeID: string; position: number; busy: boolean } | undefined> => {
    if (destination.kind === "session") {
      const info = await options.session.get({ sessionID: destination.sessionID })
      const items = await options.session.inbox.list({ sessionID: destination.sessionID })
      if (info.id !== destination.sessionID || items.some((item) => item.sessionID !== destination.sessionID)) throw new Error("Wrong native queue")
      const users = items.filter((item) => item.type === "user"), index = users.findIndex((item) => item.id === inputID)
      if (index < 0) return undefined
      if (users.filter((item) => item.id === inputID).length !== 1) throw new Error("Ambiguous native queue")
      return { nativeID: inputID, position: index + 1, busy: info.time.busy !== undefined && (info.time.idle === undefined || info.time.busy > info.time.idle) }
    }
    let cursor: string | undefined, count = 0
    const cursors = new Set<string>(), found: { nativeID: string; position: number; busy: boolean }[] = []
    do {
      const page = await options.backend.execution({ ref: destination.ref, cursor, limit: 100 })
      if (!sameTarget(destination, { kind: "backend", ref: page.thread.ref })) throw new Error("Wrong native queue")
      page.queue.forEach((item, index) => { if (item.inputID === inputID) found.push({ nativeID: item.nativeID, position: count + index + 1,
        busy: page.turn?.state === "running" || page.thread.state === "running" || page.thread.state === "waiting" }) })
      count += page.queue.length; cursor = page.nextCursor
      if (cursor && cursors.has(cursor) || count > 10000) throw new Error("Incomplete native queue")
      if (cursor) cursors.add(cursor)
    } while (cursor)
    if (found.length > 1) throw new Error("Ambiguous native queue")
    return found[0]
  }
  const lifecycle = async (value: Intent): Promise<"delivered" | "cancelled" | undefined> => {
    if (value.target.kind === "backend") {
      const proof = await storage.get(key(value.target, value.inputID) + ":cancelled")
      if (proof !== undefined) {
        if (!record(proof) || proof.hash !== value.hash || proof.nativeID !== value.nativeID) throw new Error("Wrong native cancellation")
        return "cancelled"
      }
      if (!options.backend.input) return undefined
      const position = await options.backend.input({ ref: value.target.ref, inputID: value.inputID })
      if (!sameTarget(value.target, { kind: "backend", ref: position.ref }) || position.inputID !== value.inputID) throw new Error("Wrong native input")
      return position.status === "delivered" || position.status === "closed" ? "delivered" : undefined
    }
    // Finite original event-log replay also works after restart. Absence from Inbox is never cancellation evidence.
    // The frozen notice proves the original pending observation; managed runtimes retain body-free lifecycle events.
    let state: "pending" | "delivered" | "cancelled" = "pending", count = 0, previous = -1, synced = false
    for await (const event of options.log({ sessionID: value.target.sessionID, follow: false })) {
      if (++count > 10000) throw new Error("Queue receipt history exceeds its bounded read")
      if (event.type === "log.synced") {
        if (event.aggregateID !== value.target.sessionID || event.seq !== undefined && event.seq < previous) throw new Error("Wrong native log watermark")
        synced = true; continue
      }
      if (synced || event.durable.aggregateID !== value.target.sessionID || event.durable.seq <= previous) throw new Error("Wrong native log order")
      previous = event.durable.seq
      if (event.type === "session.inbox.enqueued" && event.data.inboxID === value.inputID) {
        if (state !== "pending" || event.data.item.type !== "user") throw new Error("Reused native queue identity")
      }
      if ((event.type === "session.inbox.cancelled" || event.type === "session.inbox.delivered") && event.data.inboxID === value.inputID) {
        if (state !== "pending") throw new Error("Unproven native queue transition")
        state = event.type === "session.inbox.cancelled" ? "cancelled" : "delivered"
      }
    }
    if (!synced) throw new Error("Incomplete native queue log")
    return state === "pending" ? undefined : state
  }
  const observe = async (destination: Target, inputID: string): Promise<"cancelled" | "delivered" | undefined> => {
    if (!id(inputID)) throw new Error("Invalid queue input")
    const value = await read(destination, inputID)
    if (!value || !allowed(value.source)) return undefined
    const name = key(destination, inputID), suppressed = await storage.get(name + ":suppressed"), retired = await storage.get(name + ":retired")
    if (suppressed !== undefined) {
      if (!record(suppressed) || suppressed.hash !== value.hash) throw new Error("Wrong suppressed queue notice")
      return undefined
    }
    if (retired !== undefined) {
      if (!record(retired) || retired.hash !== value.hash || retired.status !== "cancelled" && retired.status !== "delivered") throw new Error("Wrong queue retirement")
      return retired.status
    }
    const queued = await pending(destination, inputID)
    if (queued) { if (queued.nativeID !== value.nativeID) throw new Error("Native queue identity changed"); return undefined }
    const status = await lifecycle(value)
    if (!status) return undefined
    const acknowledged = await receipts.read(name + ":receipt", value.hash)
    if (acknowledged.status !== "sent") return status
    const intention = { hash: value.hash, messageID: acknowledged.messageID, status }
    const intentKey = name + ":recall", receiptKey = intentKey + ":receipt"
    if (!await storage.insert(intentKey, intention)) {
      if (JSON.stringify(await storage.get(intentKey)) !== JSON.stringify(intention)) throw new Error("Conflicting queue recall")
      const receipt = await storage.get(receiptKey)
      if (!record(receipt) || receipt.hash !== value.hash || receipt.messageID !== acknowledged.messageID || receipt.status !== "recalled") throw new Error("Queue recall outcome remains unknown")
    } else {
      const result = await options.recall(value.source, acknowledged.messageID).catch(() => ({ status: "uncertain" as const }))
      await storage.insert(receiptKey, { hash: value.hash, messageID: acknowledged.messageID, ...result })
      if (result.status !== "recalled") throw new Error("Queue receipt could not be recalled")
    }
    const fact = { hash: value.hash, status }
    if (!await storage.insert(name + ":retired", fact) && JSON.stringify(await storage.get(name + ":retired")) !== JSON.stringify(fact)) throw new Error("Conflicting queue retirement")
    return status
  }
  return {
    observe,
    async withdrawn(entry: Withdrawal) {
      if (entry.target.kind !== "backend") return
      const value = await read(entry.target, entry.inputID)
      if (!value || value.nativeID !== entry.nativeID || !allowed(value.source)) return
      const proof = { hash: value.hash, nativeID: entry.nativeID }, name = key(entry.target, entry.inputID) + ":cancelled"
      if (!await storage.insert(name, proof) && JSON.stringify(await storage.get(name)) !== JSON.stringify(proof)) throw new Error("Conflicting native cancellation")
      await observe(entry.target, entry.inputID)
    },
    async admitted(destination: Target, inputID: string, duplicate: boolean): Promise<NotificationReceipt> {
      try {
        if (!id(inputID)) return { status: "conflict" }
        const name = key(destination, inputID), old = await read(destination, inputID)
        if (old) {
          if (!allowed(old.source)) return { status: "forbidden" }
          const suppressed = await storage.get(name + ":suppressed")
          if (suppressed !== undefined) return record(suppressed) && suppressed.hash === old.hash ? { status: "ignored" } : { status: "conflict" }
          await observe(destination, inputID)
          return receipts.finish(name + ":receipt", old.hash, true, (messageID) => options.linkReply(old.source, messageID))
        }
        // A restart or redelivery without an original notice never creates a late queue announcement.
        if (duplicate || await storage.get(name + ":receipt") !== undefined) return { status: "ignored" }
        const found = await options.sourceFor(destination, inputID)
        if (found.status !== "found") return { status: found.status === "forbidden" ? "forbidden" : "ignored" }
        if (!allowed(found.source)) return { status: "forbidden" }
        const queued = await pending(destination, inputID)
        if (!queued || !queued.busy && queued.position === 1) return { status: "ignored" }
        const item = { version: 1 as const, target: destination, inputID, nativeID: queued.nativeID, source: found.source, position: queued.position,
          controls: !!options.controls?.allowedUsers.includes(found.source.actorID) && (destination.kind === "session" || !!options.controls.backendIDs?.includes(destination.ref.backendID)) }
        const value = { ...item, hash: digest(item) }
        if (!await storage.insert(name, value)) return receipts.finish(name + ":receipt", parse(await storage.get(name), destination, inputID).hash, true)
        const stillPending = await pending(destination, inputID)
        if (!stillPending || stillPending.nativeID !== value.nativeID) {
          await storage.insert(name + ":suppressed", { hash: value.hash })
          return { status: "ignored" }
        }
        const text = "已排队，当前队列" + value.position + "，将在当前任务结束后依次处理。" + (value.controls ? "\n引用本条回复 /unqueue 可请求撤回。" : "")
        const receipt = await receipts.attempt(name + ":receipt", value.hash, value.source, text, (messageID) => options.linkReply(value.source, messageID))
        await observe(destination, inputID)
        return receipt
      } catch { return { status: "uncertain" } }
    },
  }
}
