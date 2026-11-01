import { expect, test } from "bun:test"
import { createPortal } from "../src"
import type { Native } from "../src/target"
import { inputID, scopeKey } from "../src/routing"

const policy = { botID: "10001", allowedUsers: ["20001"], allowedGroups: [] }
const scope = { botID: "10001", kind: "private" as const, peerID: "20001" }
const source = (messageID: string) => ({ scope, actorID: "20001", messageID })
const id = (name: string) => inputID(source(name))
const raw = (name: string, quote?: string) => ({ post_type: "message", message_type: "private", self_id: "10001", user_id: "20001", message_id: name,
  message: [...(quote ? [{ type: "reply", data: { id: quote } }] : []), { type: "text", data: { text: "Body " + name } }] })

async function fixture() {
  type Value = Parameters<Parameters<typeof createPortal>[0]["storage"]["set"]>[1]
  const values = new Map<string, Value>(), posts: unknown[] = [], cancelled: string[] = []
  const receipts = new Map<string, Awaited<ReturnType<NonNullable<NonNullable<Native["input"]>["followupReceipt"]>>>>()
  let lost = false, conflict = false, unknown = false, badPosition = false
  const storage = { get: async (key: string) => values.get(key), set: async (key: string, value: Value) => { values.set(key, value) },
    insert: async (key: string, value: Value) => { if (values.has(key)) return false; values.set(key, value); return true } }
  const forbidden = async () => { throw new Error("Unexpected fallback or active steer") }
  const session: Native = { get: async ({ sessionID }) => ({ id: sessionID } as Awaited<ReturnType<Native["get"]>>), prompt: forbidden,
    message: { get: async ({ messageID }) => ({ id: messageID, type: "user", text: "parent", time: { created: 1 } }) },
    inbox: { list: async () => [...receipts.values()].filter((r) => r.status === "pending").map((r) => ({ sessionID: r.sessionID, id: r.inboxID, type: "user", delivery: "queue", payload: { text: "child" }, time: { created: 1 } })),
      cancel: async (input) => { cancelled.push(input.inboxID); const r = receipts.get(input.inboxID); if (r) receipts.set(input.inboxID, { ...r, status: "cancelled" }) }, update: forbidden },
    input: { continue: forbidden, continuation: forbidden,
      position: async ({ sessionID, inputID }) => ({ sessionID, inputID: badPosition ? "msg_wrong" : inputID, ...(unknown ? {} : { rootID: id("parent") }), status: unknown ? "unknown" : "closed" }),
      followup: async (input) => { posts.push(input); if (conflict) throw { _tag: "ConflictError", message: "Native parent changed" }; const value = { sessionID: input.sessionID, inboxID: input.inboxID, expectedInputID: input.expectedInputID, rootID: input.expectedRootID, status: "pending" as const }; receipts.set(input.inboxID, value); if (lost) throw new Error("Lost acknowledgment"); return value },
      followupReceipt: async (input) => receipts.get(input.inboxID) ?? { ...input, status: "unknown" },
    } }
  const setup = createPortal({ policy, storage, session: { ...session, prompt: async (input) => ({ sessionID: input.sessionID, id: input.id!, type: "user", delivery: "queue", payload: { text: input.text }, time: { created: 1 } }) } })
  await setup.bind(scope, "ses_history"); await setup.receive(raw("parent")); await setup.linkReply(source("parent"), "parent-final")
  return { values, posts, cancelled, receipts, portal: () => createPortal({ policy, storage, session }),
    configure: (options: { lost?: boolean; conflict?: boolean; unknown?: boolean; badPosition?: boolean }) => {
      lost = options.lost ?? lost; conflict = options.conflict ?? conflict; unknown = options.unknown ?? unknown; badPosition = options.badPosition ?? badPosition
    } }
}

test("proven closed input creates a new linked input with its own original source", async () => {
  const f = await fixture(), portal = f.portal()
  expect(await portal.receive(raw("child", "parent-final"))).toMatchObject({ status: "followup", inputID: id("child"), parentInputID: id("parent"), delivery: "pending" })
  expect(f.posts[0]).toMatchObject({ sessionID: "ses_history", inboxID: id("child"), expectedInputID: id("parent"), expectedRootID: id("parent"), text: "Body child" })
  expect(await portal.sourceFor({ kind: "session", sessionID: "ses_history" }, id("child"))).toEqual({ status: "found", source: source("child") })
  expect(await portal.sourceFor({ kind: "session", sessionID: "ses_history" }, id("parent"))).toEqual({ status: "found", source: source("parent") })
  await portal.linkReply(source("child"), "child-receipt")
})

test("lost historical follow-up acknowledgments only reconcile after restart and rebinding", async () => {
  const f = await fixture(); f.configure({ lost: true })
  expect((await f.portal().receive(raw("child", "parent"))).status).toBe("followup")
  f.values.set("binding:" + scopeKey(scope), "ses_elsewhere")
  expect(await f.portal().receive(raw("child", "parent"))).toMatchObject({ status: "followup", target: { kind: "session", sessionID: "ses_history" }, duplicate: true })
  expect(f.posts).toHaveLength(1)
  f.receipts.clear()
  expect((await f.portal().receive(raw("child", "parent"))).status).toBe("uncertain")
  expect(f.posts).toHaveLength(1)
})

test("missing ownership and mismatched position never fall back to a new prompt", async () => {
  const f = await fixture(); f.configure({ unknown: true })
  expect((await f.portal().receive(raw("missing", "parent"))).status).toBe("uncertain")
  f.configure({ unknown: false, badPosition: true })
  expect((await f.portal().receive(raw("wrong", "parent"))).status).toBe("uncertain")
  expect(f.posts).toEqual([])
})

test("an admission race or changed parent closure is reported without reinterpreting the same message", async () => {
  const f = await fixture(); f.configure({ conflict: true })
  expect(await f.portal().receive(raw("child", "parent"))).toEqual({ status: "blocked", reason: "quoted-task-not-closed" })
  expect((await f.portal().receive(raw("child", "parent"))).status).toBe("uncertain")
  expect(f.posts).toHaveLength(1)
})

test("recalling a linked queued task withdraws only the child and leaves the original task intact", async () => {
  const f = await fixture(), portal = f.portal()
  await portal.receive(raw("child", "parent"))
  expect(await portal.receive({ post_type: "notice", notice_type: "friend_recall", self_id: "10001", user_id: "20001", message_id: "child" })).toEqual({ status: "withdrawn" })
  expect(f.cancelled).toEqual([id("child")])
  expect(await portal.sourceFor({ kind: "session", sessionID: "ses_history" }, id("parent"))).toEqual({ status: "found", source: source("parent") })
})
