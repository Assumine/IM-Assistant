import { createHash } from "node:crypto"
import type { OpenCodeClient } from "../../../opencode/packages/client/src/promise"
import type { StorageDomain } from "../../../opencode/packages/plugin/src/promise/storage"
import type { Source, SourceResult } from "./sources"
import { sourceKey } from "./sources"
import type { Policy } from "./routing"
import type { Target } from "./target"
import type { SendResult } from "./onebot"
import type { NotificationReceipt } from "./notifications"
import { delivery } from "./delivery"

type Client = {
  event: Pick<OpenCodeClient["event"], "subscribe">
  session: { message: Pick<OpenCodeClient["session"]["message"], "get"> }
  experimental: { session: { input: Pick<OpenCodeClient["experimental"]["session"]["input"], "output"> } }
}
type Storage = Pick<StorageDomain, "get" | "insert" | "scan" | "remove">
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const text = (value: string) => value.length <= 16000 ? value : value.slice(0, 15500) + "\n\n（回复较长，此处为节选；请在客户端查看全文。）"

/** Observes original Session output only. This registry contains notification subscriptions, never executable work. */
export function createTaskReplies(options: {
  client: Client; storage: Storage; policy: Policy
  sourceFor: (target: Target, inputID: string) => Promise<SourceResult>
  linkReply: (source: Source, outgoingID: string) => Promise<void>
  send: (source: Source, text: string) => Promise<SendResult | { status: "forbidden" }>
}) {
  const receipts = delivery(options), { client, storage, policy } = options
  const prefix = "notification-watch:" + policy.botID + ":"
  const watchKey = (sessionID: string, inputID: string) => prefix + sourceKey({ kind: "session", sessionID }, inputID)
  const forward = async (sessionID: string, inputID: string): Promise<NotificationReceipt> => {
    try {
      if (!id(sessionID) || !id(inputID)) return { status: "conflict" }
      const target: Target = { kind: "session", sessionID }, found = await options.sourceFor(target, inputID)
      if (found.status !== "found") return { status: found.status === "forbidden" ? "forbidden" : found.status === "missing" ? "ignored" : "uncertain" }
      const source = found.source
      if (source.scope.botID !== policy.botID || !policy.allowedUsers.includes(source.actorID) ||
        (source.scope.kind === "private" ? source.scope.peerID !== source.actorID : !policy.allowedGroups.includes(source.scope.peerID))) return { status: "forbidden" }
      const output = await client.experimental.session.input.output({ sessionID, inputID })
      if (output.sessionID !== sessionID || output.inputID !== inputID || output.rootID && output.rootID !== inputID) return { status: "conflict" }
      if (!output.rootID || output.status !== "open" && output.status !== "closed") return { status: "ignored" }
      const phase = output.status === "closed" ? "final" : "first", reply = phase === "final" ? output.last : output.first
      if (!reply?.settled || !reply.text.trim()) return { status: "ignored" }
      const settled = async (pending: Promise<NotificationReceipt>) => {
        const receipt = await pending
        // A confirmed final no longer needs event catch-up. Failed metadata cleanup never causes another send.
        if (phase === "final" && receipt.status === "sent" && receipt.linkage === "linked") {
          try { await storage.remove(watchKey(sessionID, inputID)) } catch { /* Bounded catch-up can repair this metadata later. */ }
        }
        return receipt
      }
      const body = text(reply.text), root = sourceKey(target, output.rootID)
      const value = { version: 1, target, rootID: output.rootID, nativeID: reply.messageID, source, bodyHash: hash(body) }
      const intent = { ...value, hash: hash(value) }
      const slotKey = "notification-slot:task:" + root + ":" + phase
      const selected = { version: 1, nativeID: reply.messageID, hash: intent.hash }
      if (!await storage.insert(slotKey, selected) && JSON.stringify(await storage.get(slotKey)) !== JSON.stringify(selected)) return { status: "conflict" }
      // First and final can refer to the same native message. They share one intent and one actual send attempt.
      const key = "notification:task:" + root + ":" + hash(reply.messageID), receiptKey = "notification-receipt:task:" + root + ":" + hash(reply.messageID)
      const publish = (messageID: string) => options.linkReply(source, messageID)
      const old = await storage.get(key)
      if (old !== undefined) {
        if (JSON.stringify(old) !== JSON.stringify(intent)) return { status: "conflict" }
        return await settled(receipts.finish(receiptKey, intent.hash, true, publish))
      }
      if (await storage.get(receiptKey) !== undefined) return { status: "uncertain" }
      if (!await storage.insert(key, intent)) {
        if (JSON.stringify(await storage.get(key)) !== JSON.stringify(intent)) return { status: "conflict" }
        return await settled(receipts.finish(receiptKey, intent.hash, true, publish))
      }
      return await settled(receipts.attempt(receiptKey, intent.hash, source, body, publish))
    } catch { return { status: "uncertain" } }
  }
  const remember = async (sessionID: string, inputID: string) => {
    if (!id(sessionID) || !id(inputID)) throw new Error("Invalid native notification subscription")
    const value = { sessionID, inputID }
    const key = watchKey(sessionID, inputID)
    if (!await storage.insert(key, value) && JSON.stringify(await storage.get(key)) !== JSON.stringify(value)) throw new Error("Conflicting notification subscription")
  }
  return { forward, remember, watchKey, prefix }
}

/** One public event subscription per enabled account. It never prompts/resumes a Session or polls a native task. */
export function openTaskReplies(options: Parameters<typeof createTaskReplies>[0] & {
  ready: Promise<boolean>
  onReceipt?: (value: NotificationReceipt) => void
  onUnavailable?: () => void
}) {
  const replies = createTaskReplies(options), controller = new AbortController(), jobs = new Set<Promise<void>>()
  const report = (value: NotificationReceipt) => { try { options.onReceipt?.(value) } catch { /* Observer only. */ } }
  const check = async (sessionID: string, inputID: string) => {
    if (!await options.ready || controller.signal.aborted) return
    report(await replies.forward(sessionID, inputID))
  }
  const track = (job: Promise<void>) => { jobs.add(job); void job.finally(() => jobs.delete(job)); return job }
  const reconcile = async (sessionID?: string) => {
    let after: string | undefined
    do {
      const page = await options.storage.scan({ prefix: replies.prefix, after, limit: 100 })
      for (const entry of page.entries) {
        const value = entry.value
        if (!record(value) || !id(value.sessionID) || !id(value.inputID) || entry.key !== replies.watchKey(value.sessionID, value.inputID)) throw new Error("Invalid notification subscription")
        if (!sessionID || sessionID === value.sessionID) await check(value.sessionID, value.inputID)
      }
      if (page.next && page.next === after) throw new Error("Repeated notification cursor")
      after = page.next
    } while (after && !controller.signal.aborted)
  }
  const observing = (async () => {
    try {
      for await (const event of options.client.event.subscribe({ signal: controller.signal, types: ["session.step.streamed", "session.step.ended", "session.step.failed", "session.input.closed", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"] })) {
        if (controller.signal.aborted) break
        try {
        if (event.type === "server.connected") { await reconcile(); continue }
        if (event.type === "session.input.closed") { await check(event.data.sessionID, event.data.rootID); continue }
        if (event.type === "session.step.streamed" || event.type === "session.step.ended" || event.type === "session.step.failed") {
          const message = await options.client.session.message.get({ sessionID: event.data.sessionID, messageID: event.data.assistantMessageID })
          if (message.type === "assistant" && message.inputRootID) await check(event.data.sessionID, message.inputRootID)
          continue
        }
        // Terminal execution can close the input without a separate InputClosed event (failure/user interrupt).
        await reconcile(event.data.sessionID)
        } catch { if (!controller.signal.aborted) report({ status: "uncertain" }) }
      }
    } catch { if (!controller.signal.aborted) { try { options.onUnavailable?.() } catch { /* Optional capability stays isolated. */ } } }
  })()
  return {
    admitted(sessionID: string, inputID: string) {
      return track((async () => { try { await replies.remember(sessionID, inputID); await check(sessionID, inputID) } catch { report({ status: "uncertain" }) } })())
    },
    async close() { controller.abort(); await observing; await Promise.allSettled(jobs) },
  }
}
