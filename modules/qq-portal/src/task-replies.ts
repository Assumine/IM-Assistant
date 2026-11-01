import { createHash } from "node:crypto"
import type { OpenCodeClient } from "../../../opencode/packages/client/src/promise"
import type { RpcClient } from "../../../opencode/packages/client/src/promise/api"
import type { ConversationBackend } from "../../../opencode/packages/schema/src/conversation-backend"
import type { StorageDomain } from "../../../opencode/packages/plugin/src/promise/storage"
import type { Source, SourceResult } from "./sources"
import { sourceKey } from "./sources"
import type { Policy } from "./routing"
import { target, sameTarget, type Target } from "./target"
import type { SendResult } from "./onebot"
import type { NotificationReceipt } from "./notifications"
import { delivery } from "./delivery"

type Client = {
  event: Pick<OpenCodeClient["event"], "subscribe">
  session: { message: Pick<OpenCodeClient["session"]["message"], "get"> }
  experimental: { session: { input: Pick<OpenCodeClient["experimental"]["session"]["input"], "output"> } }
}
type Storage = Pick<StorageDomain, "get" | "insert" | "scan" | "remove">
type Backend = Pick<RpcClient<typeof ConversationBackend.Api>, "output" | "events">
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const text = (value: string) => value.length <= 16000 ? value : value.slice(0, 15500) + "\n\n（回复较长，此处为节选；请在客户端查看全文。）"

/** Observes native public output. This registry contains notification subscriptions, never executable work. */
export function createTaskReplies(options: {
  client: Client; backend?: Backend; storage: Storage; policy: Policy
  sourceFor: (target: Target, inputID: string) => Promise<SourceResult>
  linkReply: (source: Source, outgoingID: string) => Promise<void>
  send: (source: Source, text: string) => Promise<SendResult | { status: "forbidden" }>
}) {
  const receipts = delivery(options), { client, storage, policy } = options
  const prefix = "notification-watch:" + policy.botID + ":"
  const watchKey = (value: string | Target, inputID: string) => prefix + sourceKey(target(value), inputID)
  const forward = async (value: string | Target, inputID: string): Promise<NotificationReceipt> => {
    try {
      if (!id(inputID)) return { status: "conflict" }
      const destination = target(value), found = await options.sourceFor(destination, inputID)
      if (found.status !== "found") return { status: found.status === "forbidden" ? "forbidden" : found.status === "missing" ? "ignored" : "uncertain" }
      const source = found.source
      if (source.scope.botID !== policy.botID || !policy.allowedUsers.includes(source.actorID) ||
        (source.scope.kind === "private" ? source.scope.peerID !== source.actorID : !policy.allowedGroups.includes(source.scope.peerID))) return { status: "forbidden" }
      if (destination.kind === "backend" && !options.backend) return { status: "unavailable" }
      const output = destination.kind === "session"
        ? await client.experimental.session.input.output({ sessionID: destination.sessionID, inputID })
        : await options.backend!.output({ ref: destination.ref, inputID })
      if (output.inputID !== inputID || (destination.kind === "session"
        ? !("sessionID" in output) || output.sessionID !== destination.sessionID
        : !("ref" in output) || !sameTarget(destination, { kind: "backend", ref: output.ref }))) return { status: "conflict" }
      if (!("rootID" in output) || !output.rootID || output.status !== "open" && output.status !== "closed") return { status: "ignored" }
      if (output.rootID !== inputID) return { status: "conflict" }
      const phase = output.status === "closed" ? "final" : "first", publicReply = phase === "final" ? output.last : output.first
      const terminal = "state" in output && output.status === "closed" &&
        (output.state !== "completed" || !publicReply?.settled || !publicReply.text.trim()) ? output : undefined
      const reply = terminal ? { messageID: terminal.turnID, settled: true, text: terminal.state === "failed"
        ? "本次执行失败，请在客户端查看具体错误。" : terminal.state === "interrupted"
          ? "本次执行已中断，请在客户端查看当前结果。" : "本次执行已结束，未生成可转发的文字回复。" } : publicReply
      if (!reply?.settled || !reply.text.trim()) return { status: "ignored" }
      const settled = async (pending: Promise<NotificationReceipt>) => {
        const receipt = await pending
        // A confirmed final no longer needs event catch-up. Failed metadata cleanup never causes another send.
        if (phase === "final" && receipt.status === "sent" && receipt.linkage === "linked") {
          try { await storage.remove(watchKey(destination, inputID)) } catch { /* Bounded catch-up can repair this metadata later. */ }
        }
        return receipt
      }
      const body = text(reply.text), root = sourceKey(destination, output.rootID)
      const notice = { version: 1, target: destination, rootID: output.rootID, nativeID: reply.messageID, source, bodyHash: hash(body),
        ...("turnID" in output ? { turnID: output.turnID } : {}), ...(terminal ? { kind: "terminal", state: terminal.state } : {}) }
      const intent = { ...notice, hash: hash(notice) }
      const slotKey = "notification-slot:task:" + root + ":" + phase
      const selected = { version: 1, nativeID: reply.messageID, hash: intent.hash }
      if (!await storage.insert(slotKey, selected) && JSON.stringify(await storage.get(slotKey)) !== JSON.stringify(selected)) return { status: "conflict" }
      // First and final can refer to the same native message. They share one intent and one actual send attempt.
      const item = hash(terminal ? ["terminal", reply.messageID] : reply.messageID)
      const key = "notification:task:" + root + ":" + item, receiptKey = "notification-receipt:task:" + root + ":" + item
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
  const remember = async (entry: string | Target, inputID: string) => {
    if (!id(inputID)) throw new Error("Invalid native notification subscription")
    const destination = target(entry)
    // Preserve the original Session subscription shape and receipt keys across this capability upgrade.
    const value: { sessionID: string; inputID: string } | { target: Target; inputID: string } = destination.kind === "session"
      ? { sessionID: destination.sessionID, inputID } : { target: destination, inputID }
    const key = watchKey(destination, inputID)
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
  const check = async (destination: string | Target, inputID: string) => {
    if (!await options.ready || controller.signal.aborted) return
    report(await replies.forward(destination, inputID))
  }
  const track = (job: Promise<void>) => { jobs.add(job); void job.finally(() => jobs.delete(job)); return job }
  const reconcile = async (filter?: Target) => {
    let after: string | undefined
    do {
      const page = await options.storage.scan({ prefix: replies.prefix, after, limit: 100 })
      for (const entry of page.entries) {
        const value = entry.value
        if (!record(value) || !id(value.inputID)) throw new Error("Invalid notification subscription")
        const destination = target("target" in value ? value.target : value.sessionID)
        if (entry.key !== replies.watchKey(destination, value.inputID)) throw new Error("Invalid notification subscription")
        if (!filter || sameTarget(filter, destination)) await check(destination, value.inputID)
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
        await reconcile({ kind: "session", sessionID: event.data.sessionID })
        } catch { if (!controller.signal.aborted) report({ status: "uncertain" }) }
      }
    } catch { if (!controller.signal.aborted) { try { options.onUnavailable?.() } catch { /* Optional capability stays isolated. */ } } }
  })()
  const backendObserving = options.backend ? (async () => {
    try {
      for await (const event of options.backend!.events.subscribe("activity", { signal: controller.signal })) {
        if (controller.signal.aborted) break
        try { await reconcile({ kind: "backend", ref: event.data.ref }) }
        catch { if (!controller.signal.aborted) report({ status: "uncertain" }) }
      }
    } catch { if (!controller.signal.aborted) { try { options.onUnavailable?.() } catch { /* Observer only. */ } } }
  })() : Promise.resolve()
  const backendChanges = options.backend ? (async () => {
    try {
      for await (const _event of options.backend!.events.subscribe("changed", { signal: controller.signal })) {
        if (controller.signal.aborted) break
        try { await reconcile() } catch { if (!controller.signal.aborted) report({ status: "uncertain" }) }
      }
    } catch { if (!controller.signal.aborted) { try { options.onUnavailable?.() } catch { /* Observer only. */ } } }
  })() : Promise.resolve()
  return {
    admitted(destination: string | Target, inputID: string) {
      const retained = Promise.withResolvers<boolean>()
      track((async () => {
        try { await replies.remember(destination, inputID); retained.resolve(true); await check(destination, inputID) }
        catch { retained.resolve(false); report({ status: "uncertain" }) }
      })())
      return retained.promise
    },
    async close() { controller.abort(); await Promise.all([observing, backendObserving, backendChanges]); await Promise.allSettled(jobs) },
  }
}
