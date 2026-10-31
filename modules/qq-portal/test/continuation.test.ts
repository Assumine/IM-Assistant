import { expect, test } from "bun:test"
import { createPortal } from "../src"
import type { Native } from "../src/target"
import { decode, inputID, scopeKey } from "../src/routing"

const policy = { botID: "10001", allowedUsers: ["20001"], allowedGroups: [] }
const scope = { botID: "10001", kind: "private" as const, peerID: "20001" }
const raw = (id: string, quote?: string) => ({ post_type: "message", message_type: "private", self_id: "10001", user_id: "20001", message_id: id,
  message: [...(quote ? [{ type: "reply", data: { id: quote } }] : []), { type: "text", data: { text: "Body " + id } }] })
const nativeID = (id: string) => {
  const event = decode(raw(id), policy)
  if (event.kind !== "message") throw new Error("Expected message")
  return inputID(event.message)
}
const source = (id: string) => ({ scope, messageID: id, actorID: "20001" })

async function fixture() {
  type Value = Parameters<Parameters<typeof createPortal>[0]["storage"]["set"]>[1]
  const values = new Map<string, Value>()
  const posts: Parameters<NonNullable<Native["input"]>["continue"]>[0][] = []
  const receipts = new Map<string, Awaited<ReturnType<NonNullable<Native["input"]>["continuation"]>>>()
  let prompts = 0, conflict = false, lost = false, confirmed = true
  const storage = {
    get: async (key: string) => values.get(key), set: async (key: string, value: Value) => { values.set(key, value) },
    insert: async (key: string, value: Value) => { if (values.has(key)) return false; values.set(key, value); return true },
  }
  const forbidden = async () => { throw new Error("Unexpected native mutation") }
  const session: Native = { get: forbidden,
    prompt: async (input) => { prompts++; return { id: input.id!, sessionID: input.sessionID, type: "user", payload: { text: input.text }, time: { created: 1 }, delivery: "queue" } },
    inbox: { list: async () => [], cancel: forbidden, update: forbidden },
    message: { get: async ({ messageID }) => ({ id: messageID, type: "user", text: "parent", time: { created: 1 } }) },
    input: {
      continue: async (input) => {
        posts.push(input)
        if (conflict) throw { _tag: "ConflictError", message: "Native input boundary changed" }
        const receipt = { sessionID: input.sessionID, expectedInputID: input.expectedInputID, inboxID: input.inboxID, rootID: nativeID("parent"), status: "pending" as const }
        if (confirmed) receipts.set(input.inboxID, receipt)
        if (lost) throw new Error("Continuation acknowledgment lost")
        return receipt
      },
      continuation: async (input) => receipts.get(input.inboxID) ?? { ...input, status: "unknown" },
    },
  }
  const portal = () => createPortal({ policy, storage, session })
  values.set("binding:" + scopeKey(scope), "ses_active")
  await portal().receive(raw("parent"))
  await portal().linkReply(source("parent"), "parent-reply")
  return { values, posts, receipts, session, portal, prompts: () => prompts,
    configure: (options: { conflict?: boolean; lost?: boolean; confirmed?: boolean }) => {
      conflict = options.conflict ?? conflict; lost = options.lost ?? lost; confirmed = options.confirmed ?? confirmed
    } }
}

test("quoted active input uses only the guarded native API and retains the original task and source", async () => {
  const f = await fixture(), portal = f.portal()
  expect(await portal.receive(raw("adjust", "parent-reply"))).toMatchObject({ status: "steered", inputID: nativeID("parent"), continuationID: nativeID("adjust"), delivery: "pending", duplicate: false })
  expect(f.posts).toHaveLength(1)
  expect(f.posts[0]).toMatchObject({ sessionID: "ses_active", expectedInputID: nativeID("parent"), inboxID: nativeID("adjust"), text: "Body adjust", metadata: { qq: { messageID: "adjust", quoteID: "parent-reply" } } })
  expect(f.prompts()).toBe(1)
  expect(await portal.sourceFor({ kind: "session", sessionID: "ses_active" }, nativeID("parent"))).toEqual({ status: "found", source: source("parent") })
  expect(await portal.sourceFor({ kind: "session", sessionID: "ses_active" }, nativeID("adjust"))).toEqual({ status: "missing" })
})

test("lost continuation acknowledgments reconcile across restart and rebinding without POST or prompt replay", async () => {
  const f = await fixture(); f.configure({ lost: true })
  expect((await f.portal().receive(raw("adjust", "parent"))).status).toBe("steered")
  f.values.set("binding:" + scopeKey(scope), "ses_other")
  expect(await f.portal().receive(raw("adjust", "parent"))).toMatchObject({ status: "steered", target: { kind: "session", sessionID: "ses_active" }, duplicate: true })
  expect(f.posts).toHaveLength(1)
  expect(f.prompts()).toBe(1)
})

test("unknown handoff stays unknown and does not turn into a new task after a native boundary conflict", async () => {
  const f = await fixture(); f.configure({ conflict: true })
  expect(await f.portal().receive(raw("late", "parent"))).toEqual({ status: "blocked", reason: "quoted-task-not-active" })
  expect(await f.portal().receive(raw("late", "parent"))).toEqual({ status: "uncertain" })
  expect(f.posts).toHaveLength(1)
  f.configure({ conflict: false, lost: true, confirmed: false })
  expect(await f.portal().receive(raw("unknown", "parent"))).toEqual({ status: "uncertain" })
  expect(await f.portal().receive(raw("unknown", "parent"))).toEqual({ status: "uncertain" })
  expect(f.posts).toHaveLength(2)
  expect(f.prompts()).toBe(1)
})

test("delivered evidence is historical; expired and cancelled continuations do not claim application or register replies", async () => {
  const f = await fixture(), portal = f.portal()
  for (const status of ["delivered", "expired", "cancelled"] as const) {
    await portal.receive(raw(status, "parent"))
    f.receipts.set(nativeID(status), { ...f.receipts.get(nativeID(status))!, status })
    const result = await portal.receive(raw(status, "parent"))
    if (status === "delivered") {
      expect(result).toMatchObject({ status: "steered", delivery: "delivered", duplicate: true })
      await portal.linkReply(source(status), "delivered-reply")
    } else {
      expect(result).toEqual({ status: "blocked", reason: `quoted-adjustment-${status}` })
      await expect(portal.linkReply(source(status), status + "-reply")).rejects.toThrow("not confirmed")
    }
  }
  expect(f.posts).toHaveLength(3)
  expect(f.prompts()).toBe(1)
})

test("recalling a current adjustment or its reply cannot withdraw the original task", async () => {
  const f = await fixture(), portal = f.portal()
  await portal.receive(raw("adjust", "parent")); await portal.linkReply(source("adjust"), "adjust-reply")
  for (const messageID of ["adjust", "adjust-reply"]) expect(await portal.receive({ post_type: "notice", notice_type: "friend_recall", self_id: "10001", user_id: "20001", message_id: messageID })).toEqual({ status: "unchanged" })
  expect((await portal.receive(raw("next-adjust", "adjust-reply"))).status).toBe("steered")
  expect(f.posts[1].expectedInputID).toBe(nativeID("parent"))
  expect(f.prompts()).toBe(1)
})

test("wrong native receipt identities fail closed without replacing the frozen target", async () => {
  const f = await fixture(), portal = f.portal()
  await portal.receive(raw("adjust", "parent"))
  f.receipts.set(nativeID("adjust"), { ...f.receipts.get(nativeID("adjust"))!, expectedInputID: "msg_other" })
  expect(await portal.receive(raw("adjust", "parent"))).toEqual({ status: "uncertain" })
  expect(f.posts).toHaveLength(1)
  expect(f.prompts()).toBe(1)
})
