import { expect, test } from "bun:test"
import type { OpenCodeClient } from "../../../opencode/packages/client/src/promise"
import type { Native, Backend, Target } from "../src/target"
import type { Source } from "../src/sources"
import type { SendResult, RecallResult } from "../src/onebot"
import { createQueueReplies } from "../src/queue-replies"
import { configuration } from "../src/configuration"
import { historyStorage } from "./fixture/history"
import { policy } from "./fixture/onebot"

const destination: Target = { kind: "session", sessionID: "ses_queue" }
const remote: Target = { kind: "backend", ref: { backendID: "codex-native", threadID: "native-thread" } }
const source: Source = { scope: { botID: "10001", kind: "private", peerID: "20001" }, actorID: "20001", messageID: "10" }
function fixture() {
  const f = historyStorage(), sends: { source: Source; text: string }[] = [], recalls: { source: Source; messageID: string }[] = [], links: string[] = []
  let busy = true, pending = true, state: "pending" | "delivered" | "cancelled" | "unknown" = "pending"
  let sent: SendResult = { status: "sent", messageID: "-500" }, recalled: RecallResult = { status: "recalled" }
  const row = (id: string) => ({ id, sessionID: "ses_queue", type: "user", payload: { text: "Private task text" }, delivery: "queue", time: { created: 1 } })
  const session: Pick<Native, "get" | "inbox"> = {
    get: async () => ({ id: "ses_queue", time: { busy: busy ? 2 : undefined, idle: 1 } }) as Awaited<ReturnType<Native["get"]>>,
    inbox: { list: async () => (pending ? [row("msg_queue")] : []) as Awaited<ReturnType<Native["inbox"]["list"]>>, cancel: async () => { throw new Error("Notification must not cancel a task") }, update: async () => { throw new Error("Notification must not change a task") } },
  }
  const backend: Backend = {
    query: async () => { throw new Error("No native mutation") }, control: async () => { throw new Error("No native mutation") },
    send: async () => { throw new Error("No native mutation") }, reconcile: async () => { throw new Error("No native mutation") },
    input: async ({ ref, inputID }) => state === "delivered" ? { ref, inputID, status: "delivered", nativeID: "actual-user", turnID: "turn" }
      : pending ? { ref, inputID, status: "queued", nativeID: "native-pending" } : { ref, inputID, status: "unknown" },
    execution: async ({ ref }) => ({ thread: { ref, title: "Native", state: busy ? "running" : "idle" }, queue: pending ? [{ inputID: "msg_queue", nativeID: "native-pending", text: "Private task text", partial: false }] : [] }),
  }
  type Item = OpenCodeClient["experimental"]["session"]["log"] extends (...args: never[]) => AsyncIterable<infer T> ? T : never
  const log: OpenCodeClient["experimental"]["session"]["log"] = async function* (request) {
    expect(request).toEqual({ sessionID: "ses_queue", follow: false })
    const types = state === "unknown" ? [] : ["session.inbox.enqueued", ...(state === "pending" ? [] : ["session.inbox." + state])]
    for (let seq = 0; seq < types.length; seq++) yield { id: "evt_queue_" + seq, type: types[seq], created: 1,
      durable: { aggregateID: "ses_queue", seq, version: 1 }, data: { sessionID: "ses_queue", inboxID: "msg_queue", item: row("msg_queue") } } as Item
    yield { type: "log.synced", aggregateID: "ses_queue", seq: types.length - 1 } as Item
  }
  const options = { policy, storage: f.storage, session, backend, log,
    controls: { allowedUsers: ["20001"], backendIDs: ["codex-native"] },
    sourceFor: async () => ({ status: "found" as const, source }), linkReply: async (_source: Source, messageID: string) => { links.push(messageID) },
    send: async (source: Source, text: string): Promise<SendResult> => { sends.push({ source, text }); return sent },
    recall: async (source: Source, messageID: string): Promise<RecallResult> => { recalls.push({ source, messageID }); return recalled },
  }
  return { ...f, options, sends, recalls, links, session, backend, portal: () => createQueueReplies(options),
    state(value: typeof state) { state = value; pending = value === "pending" }, busy(value: boolean) { busy = value },
    sendResult(value: SendResult) { sent = value }, recallResult(value: RecallResult) { recalled = value }, row }
}

test("queue feedback is explicit per account and old configurations remain unchanged", () => {
  const base = { version: 1, enabled: true, accounts: [{ policy, url: "ws://127.0.0.1:3000/", tokenEnv: "IM_QQ_TOKEN_TEST" }] }
  expect(configuration(base).accounts[0]?.queueReplies).toBeUndefined()
  expect(configuration({ ...base, accounts: [{ ...base.accounts[0], queueReplies: true }] }).accounts[0]?.queueReplies).toBe(true)
  expect(() => configuration({ ...base, accounts: [{ ...base.accounts[0], queueReplies: "true" }] })).toThrow()
})

test("busy native input gets one original-quote notice, never queue zero or a copied task", async () => {
  const f = fixture(), queue = f.portal()
  expect((await queue.admitted(destination, "msg_queue", false)).status).toBe("sent")
  expect(f.sends).toEqual([{ source, text: "已排队，当前队列1，将在当前任务结束后依次处理。\n引用本条回复 /unqueue 可请求撤回。" }])
  expect(f.links).toEqual(["-500"])
  expect((await queue.admitted(destination, "msg_queue", true)).status).toBe("sent")
  expect(f.sends).toHaveLength(1)
  expect(JSON.stringify([...f.values.values()])).not.toContain("Private task text")
})

test("native desktop inputs count in the position without a second FIFO list", async () => {
  const f = fixture()
  f.session.inbox.list = async () => [f.row("desktop"), f.row("msg_queue")] as Awaited<ReturnType<Native["inbox"]["list"]>>
  expect((await f.portal().admitted(destination, "msg_queue", false)).status).toBe("sent")
  expect(f.sends[0]?.text).toContain("当前队列2")
})

test("idle, delivered and duplicate-without-original-notice inputs never get a late queue announcement", async () => {
  const f = fixture(), queue = f.portal()
  f.busy(false)
  expect((await queue.admitted(destination, "msg_queue", false)).status).toBe("ignored")
  f.busy(true)
  expect((await queue.admitted(destination, "msg_queue", true)).status).toBe("ignored")
  f.state("delivered")
  expect((await queue.admitted(destination, "msg_queue", false)).status).toBe("ignored")
  expect(f.sends).toEqual([])
})

test("a task that starts before its queue notice is sent stays suppressed on redelivery", async () => {
  const f = fixture(), queue = f.portal()
  let reads = 0
  f.session.inbox.list = async () => (++reads === 1 ? [f.row("msg_queue")] : []) as Awaited<ReturnType<Native["inbox"]["list"]>>
  expect((await queue.admitted(destination, "msg_queue", false)).status).toBe("ignored")
  expect((await queue.admitted(destination, "msg_queue", true)).status).toBe("ignored")
  expect(f.sends).toEqual([])
  expect(f.recalls).toEqual([])
})

test("native cancelled log proof recalls only the acknowledged bot notice and survives a restart", async () => {
  const f = fixture()
  await f.portal().admitted(destination, "msg_queue", false)
  f.state("cancelled")
  expect(await f.portal().observe(destination, "msg_queue")).toBe("cancelled")
  expect(f.recalls).toEqual([{ source, messageID: "-500" }])
  expect(await f.portal().observe(destination, "msg_queue")).toBe("cancelled")
  expect(f.recalls).toHaveLength(1)
})

test("delivery removes a stale queue notice without claiming the task was cancelled", async () => {
  const f = fixture(), queue = f.portal()
  await queue.admitted(destination, "msg_queue", false)
  f.state("delivered")
  expect(await queue.observe(destination, "msg_queue")).toBe("delivered")
  expect(f.recalls).toHaveLength(1)
})

test("an absent queue item without native terminal evidence never authorizes recall", async () => {
  const f = fixture(), queue = f.portal()
  await queue.admitted(destination, "msg_queue", false)
  f.state("unknown")
  expect(await queue.observe(destination, "msg_queue")).toBeUndefined()
  expect(f.recalls).toEqual([])
})

test("unknown send and unknown recall results are retained and never repeated after restart", async () => {
  const unknown = fixture()
  unknown.sendResult({ status: "uncertain" })
  expect((await unknown.portal().admitted(destination, "msg_queue", false)).status).toBe("uncertain")
  unknown.state("cancelled")
  await unknown.portal().observe(destination, "msg_queue")
  expect(unknown.recalls).toEqual([])
  expect((await unknown.portal().admitted(destination, "msg_queue", true)).status).toBe("uncertain")
  expect(unknown.sends).toHaveLength(1)
  const f = fixture()
  await f.portal().admitted(destination, "msg_queue", false)
  f.state("cancelled"); f.recallResult({ status: "uncertain" })
  await expect(f.portal().observe(destination, "msg_queue")).rejects.toThrow()
  await expect(f.portal().observe(destination, "msg_queue")).rejects.toThrow()
  expect(f.recalls).toHaveLength(1)
})

test("cancellation arriving before the send acknowledgment is cleaned up after that exact ID arrives", async () => {
  const f = fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  f.options.send = async (source, text) => { f.sends.push({ source, text }); entered.resolve(); await release.promise; return { status: "sent", messageID: "-501" } }
  const queue = f.portal(), pending = queue.admitted(destination, "msg_queue", false)
  await entered.promise
  f.state("cancelled")
  expect(await queue.observe(destination, "msg_queue")).toBe("cancelled")
  expect(f.recalls).toEqual([])
  release.resolve(); await pending
  expect(f.recalls).toEqual([{ source, messageID: "-501" }])
})

test("authorization is rechecked before sending and recalling, without following a newer binding", async () => {
  const f = fixture()
  await f.portal().admitted(destination, "msg_queue", false)
  f.options.policy = { ...policy, allowedUsers: [] }
  f.state("cancelled")
  expect(await f.portal().observe(destination, "msg_queue")).toBeUndefined()
  expect(f.recalls).toEqual([])
  expect((await f.portal().admitted(destination, "msg_queue", true)).status).toBe("forbidden")
})

test("whole-backend cancellation requires the exact acknowledged native submission, not disappearance", async () => {
  const f = fixture(), queue = f.portal()
  await queue.admitted(remote, "msg_queue", false)
  f.state("unknown")
  expect(await queue.observe(remote, "msg_queue")).toBeUndefined()
  await queue.withdrawn({ target: remote, inputID: "msg_queue", nativeID: "wrong-pending" })
  expect(f.recalls).toEqual([])
  await queue.withdrawn({ target: remote, inputID: "msg_queue", nativeID: "native-pending" })
  expect(f.recalls).toEqual([{ source, messageID: "-500" }])
  expect(await f.portal().observe(remote, "msg_queue")).toBe("cancelled")
})

test("foreign queues, repeated pages and malformed notice metadata fail before any recall", async () => {
  const f = fixture()
  f.options.backend = { ...f.backend, execution: async ({ ref }) => ({ thread: { ref, title: "Native", state: "running" }, queue: [], nextCursor: "same" }) }
  expect((await f.portal().admitted(remote, "msg_queue", false)).status).toBe("uncertain")
  await f.portal().admitted(destination, "msg_queue", false)
  const entry = [...f.values.entries()].find(([key]) => key.startsWith("notification:queue:"))
  expect(entry).toBeDefined()
  f.values.set(entry![0], { ...(entry![1] as Record<string, string>), hash: "bad" })
  f.state("cancelled")
  await expect(f.portal().observe(destination, "msg_queue")).rejects.toThrow()
  expect(f.recalls).toEqual([])
})
