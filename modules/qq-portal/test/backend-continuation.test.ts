import { expect, test } from "bun:test"
import { createPortal, type Backend, type Target } from "../src"
import { inputID, originKey, scopeKey } from "../src/routing"
import { origin } from "../src/sources"
import type { ConversationBackend } from "../../../opencode/packages/schema/src/conversation-backend"

const policy = { botID: "10001", allowedUsers: ["20001"], allowedGroups: [] }
const scope = { botID: "10001", kind: "private" as const, peerID: "20001" }
const source = (id: string) => ({ scope, actorID: "20001", messageID: id })
const nativeID = (id: string) => inputID(source(id))
const target: Extract<Target, { kind: "backend" }> = { kind: "backend", ref: { backendID: "native", threadID: "original-thread" } }
const raw = (id: string, quote?: string) => ({ post_type: "message", message_type: "private", self_id: "10001", user_id: "20001", message_id: id,
  message: [...(quote ? [{ type: "reply", data: { id: quote } }] : []), { type: "text", data: { text: "Body " + id } }] })

async function fixture() {
  type Value = Parameters<Parameters<typeof createPortal>[0]["storage"]["set"]>[1]
  const values = new Map<string, Value>()
  const sends: ConversationBackend.Input[] = []
  const positions = new Map<string, ConversationBackend.InputPosition>()
  const receipts = new Map<string, ConversationBackend.Admission>()
  let active = "original-turn", lost = false, unknown = false
  const forbidden = async () => { throw new Error("Unexpected Session or queue control") }
  const backend: Backend = {
    query: async () => ({ thread: { id: target.ref.threadID } }), execution: forbidden, control: forbidden,
    input: async ({ ref, inputID }) => positions.get(inputID) ?? { ref, inputID, status: "unknown" },
    send: async (input) => {
      sends.push(input)
      const value: ConversationBackend.Admission = input.delivery === "steer" && input.expectedTurnID !== active
        ? { ref: input.ref, inputID: input.inputID, status: "rejected", reason: "not-accepted" }
        : { ref: input.ref, inputID: input.inputID, status: "accepted", receipt: { nativeID: input.delivery === "steer" ? active : "queue-original", kind: input.delivery === "steer" ? "steered" : "queued" } }
      if (!unknown) receipts.set(input.inputID, value)
      if (lost) throw new Error("Lost acknowledgment")
      return value
    },
    reconcile: async ({ ref, inputID }) => receipts.get(inputID) ?? { ref, inputID, status: "uncertain" },
  }
  const storage = { get: async (key: string) => values.get(key), set: async (key: string, value: Value) => { values.set(key, value) },
    insert: async (key: string, value: Value) => { if (values.has(key)) return false; values.set(key, value); return true } }
  const session = { get: forbidden, prompt: forbidden, inbox: { list: forbidden, cancel: forbidden, update: forbidden }, message: { get: forbidden } }
  const portal = () => createPortal({ policy, storage, session, backend })
  values.set("binding:" + scopeKey(scope), target)
  await portal().receive(raw("parent"))
  await portal().linkReply(source("parent"), "outgoing")
  positions.set(nativeID("parent"), { ref: target.ref, inputID: nativeID("parent"), status: "delivered", nativeID: "message-original", turnID: active })
  return { values, sends, positions, receipts, portal, configure: (options: { active?: string; lost?: boolean; unknown?: boolean }) => {
    active = options.active ?? active; lost = options.lost ?? lost; unknown = options.unknown ?? unknown
  } }
}

test("backend quotes use fresh native input identity and the original turn precondition, never cached queue admission", async () => {
  const f = await fixture(), portal = f.portal()
  expect(await portal.receive(raw("adjust", "outgoing"))).toMatchObject({ status: "steered", target, inputID: nativeID("parent"), continuationID: nativeID("adjust"), delivery: "accepted" })
  expect(f.sends[1]).toEqual({ ref: target.ref, inputID: nativeID("adjust"), text: "Body adjust", delivery: "steer", expectedTurnID: "original-turn" })
  expect(await portal.sourceFor(target, nativeID("parent"))).toEqual({ status: "found", source: source("parent") })
  expect(await portal.sourceFor(target, nativeID("adjust"))).toEqual({ status: "missing" })
  await portal.linkReply(source("adjust"), "adjust-reply")
  expect((await portal.receive(raw("more", "adjust-reply"))).status).toBe("steered")
  expect(f.sends[2]).toMatchObject({ expectedTurnID: "original-turn" })
})

test("a turn completing between lookup and handoff refuses the adjustment instead of adding a new task", async () => {
  const f = await fixture(); f.configure({ active: "next-turn" })
  expect(await f.portal().receive(raw("late", "parent"))).toEqual({ status: "blocked", reason: "quoted-task-not-active" })
  expect(await f.portal().receive(raw("late", "parent"))).toEqual({ status: "blocked", reason: "quoted-task-not-active" })
  expect(f.sends).toHaveLength(2)
})

test("lost acknowledgments, restart and rebinding reconcile only the frozen native guidance", async () => {
  const f = await fixture(); f.configure({ lost: true })
  expect((await f.portal().receive(raw("adjust", "parent"))).status).toBe("steered")
  f.values.set("binding:" + scopeKey(scope), { kind: "session", sessionID: "ses_different" })
  f.positions.clear(); f.configure({ active: "later-turn" })
  expect(await f.portal().receive(raw("adjust", "parent"))).toMatchObject({ status: "steered", delivery: "accepted", target, duplicate: true })
  expect(f.sends).toHaveLength(2)
  f.receipts.delete(nativeID("adjust"))
  expect((await f.portal().receive(raw("adjust", "parent"))).status).toBe("uncertain")
  expect(f.sends).toHaveLength(2)
})

test("a repaired native message receipt must prove the frozen turn before claiming delivered", async () => {
  const f = await fixture(); f.configure({ lost: true, unknown: true })
  expect((await f.portal().receive(raw("adjust", "parent"))).status).toBe("uncertain")
  f.receipts.set(nativeID("adjust"), { ref: target.ref, inputID: nativeID("adjust"), status: "accepted", receipt: { nativeID: "guided-message", kind: "message" } })
  for (const turnID of ["wrong-turn", "original-turn"]) {
    f.positions.set(nativeID("adjust"), { ref: target.ref, inputID: nativeID("adjust"), status: "delivered", nativeID: "guided-message", turnID })
    expect((await f.portal().receive(raw("adjust", "parent"))).status).toBe(turnID === "original-turn" ? "steered" : "uncertain")
  }
  expect(f.sends).toHaveLength(2)
})

test("unknown identity, pending native input and a foreign owner never become unconditional steering or replacement", async () => {
  const f = await fixture()
  f.positions.clear()
  expect((await f.portal().receive(raw("unknown", "parent"))).status).toBe("uncertain")
  f.positions.set(nativeID("parent"), { ref: target.ref, inputID: nativeID("parent"), status: "queued", nativeID: "pending" })
  expect((await f.portal().receive(raw("pending", "parent"))).status).toBe("blocked")
  f.positions.set(nativeID("parent"), { ref: { ...target.ref, threadID: "foreign" }, inputID: nativeID("parent"), status: "delivered", nativeID: "message", turnID: "wrong-turn" })
  expect((await f.portal().receive(raw("wrong", "parent"))).status).toBe("uncertain")
  expect(f.sends).toHaveLength(1)
})

test("native guidance origin requires a valid immutable turn fence and recall cannot withdraw its parent", async () => {
  const f = await fixture()
  await f.portal().receive(raw("adjust", "parent"))
  const key = "origin:" + originKey(scope, "adjust"), value = f.values.get(key)
  expect(value).toMatchObject({ expectedTurnID: "original-turn" })
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected origin")
  for (const expectedTurnID of [undefined, "../invalid"]) expect(() => origin({ ...value, expectedTurnID })).toThrow()
  expect(await f.portal().receive({ post_type: "notice", notice_type: "friend_recall", self_id: "10001", user_id: "20001", message_id: "adjust" })).toEqual({ status: "unchanged" })
  expect(f.sends).toHaveLength(2)
})
