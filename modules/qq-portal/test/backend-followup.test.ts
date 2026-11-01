import { expect, test } from "bun:test"
import { createPortal, type Backend, type Target } from "../src"
import type { ConversationBackend } from "../../../opencode/packages/schema/src/conversation-backend"
import { inputID, scopeKey } from "../src/routing"

const policy = { botID: "10001", allowedUsers: ["20001"], allowedGroups: [] }
const scope = { botID: "10001", kind: "private" as const, peerID: "20001" }
const source = (messageID: string) => ({ scope, actorID: "20001", messageID })
const id = (name: string) => inputID(source(name))
const target: Extract<Target, { kind: "backend" }> = { kind: "backend", ref: { backendID: "native", threadID: "native-thread" } }
const parent = { inputID: id("parent"), turnID: "ended-turn", nativeID: "parent-native" }
const raw = (name: string, quote?: string) => ({ post_type: "message", message_type: "private", self_id: "10001", user_id: "20001", message_id: name,
  message: [...(quote ? [{ type: "reply", data: { id: quote } }] : []), { type: "text", data: { text: "Body " + name } }] })

async function fixture() {
  type Value = Parameters<Parameters<typeof createPortal>[0]["storage"]["set"]>[1]
  const values = new Map<string, Value>(), posts: ConversationBackend.Input[] = [], withdrawn: string[] = []
  const receipts = new Map<string, ConversationBackend.Admission>(), queue = new Map<string, string>()
  let lost = false, refuse = false, unknown = false, mismatch = false
  const forbidden = async () => { throw new Error("Unexpected Session or unconditional steering") }
  const backend: Backend = {
    query: async () => ({ thread: { id: target.ref.threadID } }),
    input: async ({ ref, inputID }) => unknown ? { ref, inputID, status: "unknown" } : { ref, inputID, status: "closed", nativeID: parent.nativeID, turnID: parent.turnID, state: "completed" },
    send: async (request) => {
      posts.push(request)
      if (request.delivery === "steer") throw new Error("Unconditional fallback")
      const relation = request.followupOf
      const value: ConversationBackend.Admission = relation && refuse ? { ref: request.ref, inputID: request.inputID, status: "rejected", reason: "not-accepted", followupOf: relation }
        : { ref: request.ref, inputID: request.inputID, status: "accepted", receipt: { nativeID: "queued-" + posts.length, kind: "queued" },
          ...(relation ? { followupOf: mismatch ? { ...relation, turnID: "wrong-turn" } : relation } : {}) }
      receipts.set(request.inputID, value)
      if (value.status === "accepted") queue.set(request.inputID, value.receipt.nativeID)
      if (lost) throw new Error("Lost acknowledgment")
      return value
    },
    reconcile: async ({ ref, inputID }) => receipts.get(inputID) ?? { ref, inputID, status: "uncertain" },
    execution: async ({ ref }) => ({ thread: { ref, title: "Other running work", state: "running" }, turn: { id: "different-active-turn", state: "running" },
      queue: [...queue].map(([inputID, nativeID]) => ({ inputID, nativeID, text: "queued", partial: false })) }),
    control: async ({ control }) => { if (control.action !== "withdraw") return forbidden(); withdrawn.push(control.nativeID); return { status: "applied" } },
  }
  const storage = { get: async (key: string) => values.get(key), set: async (key: string, value: Value) => { values.set(key, value) },
    insert: async (key: string, value: Value) => { if (values.has(key)) return false; values.set(key, value); return true } }
  const session = { get: forbidden, prompt: forbidden, message: { get: forbidden }, inbox: { list: forbidden, cancel: forbidden, update: forbidden } }
  const portal = () => createPortal({ storage, policy, session, backend })
  values.set("binding:" + scopeKey(scope), target)
  await portal().receive(raw("parent")); await portal().linkReply(source("parent"), "parent-final")
  queue.delete(id("parent"))
  return { values, posts, receipts, withdrawn, portal, configure: (options: { lost?: boolean; refuse?: boolean; unknown?: boolean; mismatch?: boolean }) => {
    lost = options.lost ?? lost; refuse = options.refuse ?? refuse; unknown = options.unknown ?? unknown; mismatch = options.mismatch ?? mismatch
  } }
}

test("closed native quote creates its own input with an echoed parent and historical acceptance, not pending execution", async () => {
  const f = await fixture(), portal = f.portal()
  expect(await portal.receive(raw("child", "parent-final"))).toMatchObject({ status: "followup", inputID: id("child"), parentInputID: id("parent"), delivery: "accepted" })
  expect(f.posts[1]).toEqual({ ref: target.ref, inputID: id("child"), text: "Body child", delivery: "queue", followupOf: parent })
  expect(await portal.sourceFor(target, id("child"))).toEqual({ status: "found", source: source("child") })
  expect(await portal.sourceFor(target, id("parent"))).toEqual({ status: "found", source: source("parent") })
  await portal.linkReply(source("child"), "child-receipt")
})

test("lost native linked acknowledgments stay bound through restart and rebinding without another send", async () => {
  const f = await fixture(); f.configure({ lost: true })
  expect((await f.portal().receive(raw("child", "parent"))).status).toBe("followup")
  f.values.set("binding:" + scopeKey(scope), "ses_elsewhere"); f.configure({ unknown: true })
  expect(await f.portal().receive(raw("child", "parent"))).toMatchObject({ status: "followup", target, duplicate: true, delivery: "accepted" })
  expect(f.posts).toHaveLength(2)
  f.receipts.delete(id("child"))
  expect((await f.portal().receive(raw("child", "parent"))).status).toBe("uncertain")
  expect(f.posts).toHaveLength(2)
})

test("unreadable native identity never creates a task and a definitive parent refusal never becomes a different route", async () => {
  const f = await fixture(); f.configure({ unknown: true })
  expect((await f.portal().receive(raw("unknown", "parent"))).status).toBe("uncertain")
  expect(f.posts).toHaveLength(1)
  f.configure({ unknown: false, refuse: true })
  expect(await f.portal().receive(raw("child", "parent"))).toEqual({ status: "blocked", reason: "quoted-task-not-closed" })
  expect((await f.portal().receive(raw("child", "parent"))).status).toBe("blocked")
  expect(f.posts).toHaveLength(2)
})

test("a receipt for a different native parent cannot confirm the linked handoff", async () => {
  const f = await fixture(); f.configure({ mismatch: true })
  expect((await f.portal().receive(raw("child", "parent"))).status).toBe("uncertain")
  expect((await f.portal().receive(raw("child", "parent"))).status).toBe("uncertain")
  await expect(f.portal().linkReply(source("child"), "must-not-link")).rejects.toThrow("not confirmed")
  expect(f.posts).toHaveLength(2)
})

test("native linked recall withdraws only the child submission, not its historical parent or active successor", async () => {
  const f = await fixture(), portal = f.portal()
  await portal.receive(raw("child", "parent"))
  const receipt = f.receipts.get(id("child"))
  if (receipt?.status !== "accepted") throw new Error("Expected native admission")
  expect(await portal.receive({ post_type: "notice", notice_type: "friend_recall", self_id: "10001", user_id: "20001", message_id: "child" })).toEqual({ status: "withdrawn" })
  expect(f.withdrawn).toEqual([receipt.receipt.nativeID])
  expect((await portal.receive(raw("child", "parent"))).status).toBe("recalled")
  expect(await portal.sourceFor(target, id("parent"))).toEqual({ status: "found", source: source("parent") })
})
