import { expect, test } from "bun:test"
import { openTaskReplies, type NotificationReceipt } from "../src"
import { historyStorage } from "./fixture/history"
import { policy } from "./fixture/onebot"

test("admission acknowledges a retained notification watch without waiting for output inspection", async () => {
  const f = historyStorage(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const unexpected = async () => { throw new Error("Unexpected model or send operation") }
  const sender = openTaskReplies({
    storage: f.storage, policy, ready: Promise.resolve(true),
    client: { event: { subscribe: async function* () {} }, session: { message: { get: unexpected } },
      experimental: { session: { input: { output: unexpected } } } },
    sourceFor: async () => { entered.resolve(); await release.promise; return { status: "missing" } },
    linkReply: unexpected, send: unexpected,
  })
  try {
    expect(await sender.admitted("ses_original", "msg_1")).toBe(true)
    await entered.promise
    expect([...f.values.keys()].some((key) => key.startsWith("notification-watch:"))).toBe(true)
  } finally { release.resolve(); await sender.close() }
})

test("a failed watch write cannot authorize the caller to advance its inbound recovery checkpoint", async () => {
  const f = historyStorage(), receipts: NotificationReceipt[] = []
  const unexpected = async () => { throw new Error("Unexpected output operation") }
  const sender = openTaskReplies({
    storage: { ...f.storage, insert: async () => { throw new Error("Storage unavailable") } }, policy, ready: Promise.resolve(true),
    client: { event: { subscribe: async function* () {} }, session: { message: { get: unexpected } },
      experimental: { session: { input: { output: unexpected } } } },
    sourceFor: unexpected, linkReply: unexpected, send: unexpected, onReceipt: (receipt) => receipts.push(receipt),
  })
  try {
    expect(await sender.admitted("ses_original", "msg_1")).toBe(false)
    expect(receipts).toEqual([{ status: "uncertain" }])
  } finally { await sender.close() }
})
