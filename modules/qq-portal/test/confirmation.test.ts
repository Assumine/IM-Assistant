import { expect, test } from "bun:test"
import { createPortal, type Target } from "../src"
import { inputID, originKey, scopeKey } from "../src/routing"
import type { Native } from "../src/target"

const policy = { botID: "10001", allowedUsers: ["20001", "20002"], allowedGroups: [] }
const scope = { botID: "10001", kind: "private" as const, peerID: "20001" }
const source = (messageID: string) => ({ scope, actorID: "20001", messageID })
const raw = (id: string, quote?: string, text = "Body " + id) => ({ post_type: "message", message_type: "private", self_id: "10001", user_id: "20001", message_id: id,
  message: [...(quote ? [{ type: "reply", data: { id: quote } }] : []), { type: "text", data: { text } }] })
const original: Target = { kind: "session", sessionID: "ses_original" }
const current: Target = { kind: "session", sessionID: "ses_current" }

async function fixture() {
  type Value = Parameters<Parameters<typeof createPortal>[0]["storage"]["set"]>[1]
  const values = new Map<string, Value>(), posts: unknown[] = [], receipts = new Set<string>()
  let lost = false, unknown = false
  const storage = { get: async (key: string) => values.get(key), set: async (key: string, value: Value) => { values.set(key, value) },
    insert: async (key: string, value: Value) => { if (values.has(key)) return false; values.set(key, value); return true } }
  const forbidden = async () => { throw new Error("Unexpected native mutation") }
  const session: Native = { get: async ({ sessionID }) => ({ id: sessionID } as Awaited<ReturnType<Native["get"]>>), prompt: forbidden,
    message: { get: async () => ({ id: inputID(source("parent")), type: "user", text: "parent", time: { created: 1 } }) },
    inbox: { list: async () => [], cancel: forbidden, update: forbidden },
    input: {
      continue: async (request) => { posts.push(request); if (!unknown) receipts.add(request.inboxID); if (lost) throw new Error("Lost ack"); return { ...request, rootID: request.expectedInputID, status: "pending" } },
      continuation: async (request) => ({ ...request, ...(receipts.has(request.inboxID) ? { rootID: request.expectedInputID } : {}), status: receipts.has(request.inboxID) ? "pending" : "unknown" }),
    } }
  // Obtain a genuine retained origin by a single queue admission, then use only the guarded continuation.
  const first = createPortal({ storage, policy, session: { ...session, prompt: async (request) => ({ id: request.id!, sessionID: request.sessionID, type: "user", delivery: "queue", payload: { text: request.text }, time: { created: 1 } }) } })
  await first.bind(scope, original); await first.receive(raw("parent")); await first.linkReply(source("parent"), "parent-reply")
  await first.bind(scope, current)
  const portal = () => createPortal({ storage, policy, session })
  const request = raw("cross", "parent-reply")
  const consent = { confirmationID: inputID(source("cross")), scope, actorID: "20001", choice: "approve" as const }
  return { values, posts, receipts, session, storage, portal, request, consent,
    configure: (options: { lost?: boolean; unknown?: boolean }) => { lost = options.lost ?? lost; unknown = options.unknown ?? unknown } }
}

test("cross-session input creates one body-free proposal and does not touch either native executor before consent", async () => {
  const f = await fixture()
  const replies = await Promise.all(Array.from({ length: 6 }, () => f.portal().receive(f.request)))
  expect(replies.every((row) => row.status === "confirmation-required" && row.confirmationID === f.consent.confirmationID)).toBe(true)
  expect(replies.filter((row) => row.status === "confirmation-required" && !row.duplicate)).toHaveLength(1)
  expect(f.posts).toEqual([])
  expect(JSON.stringify([...f.values.values()])).not.toContain("Body cross")
  expect(f.values.get("binding:" + scopeKey(scope))).toEqual(current)
})

test("approval continues the frozen original target once and preserves the current binding", async () => {
  const f = await fixture(); await f.portal().receive(f.request)
  const results = await Promise.all(Array.from({ length: 6 }, () => f.portal().confirm(f.request, f.consent)))
  expect(results.some((row) => row.status === "steered")).toBe(true)
  expect(f.posts).toHaveLength(1)
  expect(f.posts[0]).toMatchObject({ sessionID: "ses_original", expectedInputID: inputID(source("parent")), inboxID: f.consent.confirmationID })
  expect(f.values.get("binding:" + scopeKey(scope))).toEqual(current)
  expect((await f.portal().receive(f.request)).status).toBe("steered")
  expect(f.posts).toHaveLength(1)
})

test("pending consent survives restart, rebinding and unbinding without picking a new target", async () => {
  const f = await fixture(); await f.portal().receive(f.request)
  await f.portal().bind(scope)
  expect(await f.portal().receive(f.request)).toMatchObject({ status: "confirmation-required", target: original, duplicate: true })
  expect((await f.portal().confirm(f.request, f.consent)).status).toBe("steered")
  expect(f.values.get("binding:" + scopeKey(scope))).toBeNull()
  expect(f.posts[0]).toMatchObject({ sessionID: "ses_original" })
})

test("decline is durable and cannot later become an automatic approval", async () => {
  const f = await fixture(); await f.portal().receive(f.request)
  expect(await f.portal().confirm(f.request, { ...f.consent, choice: "decline" })).toEqual({ status: "confirmation-declined" })
  expect(await f.portal().receive(f.request)).toEqual({ status: "confirmation-declined" })
  expect(await f.portal().confirm(f.request, f.consent)).toEqual({ status: "confirmation-declined" })
  expect(f.posts).toEqual([])
})

test("another actor, scope or confirmation ID cannot approve the original request", async () => {
  const f = await fixture(); await f.portal().receive(f.request)
  expect((await f.portal().confirm(f.request, { ...f.consent, actorID: "20002" })).status).toBe("ignored")
  expect((await f.portal().confirm(f.request, { ...f.consent, scope: { ...scope, peerID: "20002" } })).status).toBe("ignored")
  expect((await f.portal().confirm(f.request, { ...f.consent, confirmationID: "msg_wrong" })).status).toBe("conflict")
  expect((await f.portal().receive(f.request)).status).toBe("confirmation-required")
  expect(f.posts).toEqual([])
})

test("approval verifies the unchanged original message and current permission", async () => {
  const f = await fixture(); await f.portal().receive(f.request)
  expect((await f.portal().confirm(raw("cross", "parent-reply", "Changed"), f.consent)).status).toBe("conflict")
  expect((await f.portal().confirm(raw("cross", "parent"), f.consent)).status).toBe("conflict")
  const revoked = createPortal({ storage: f.storage, session: f.session, policy: { ...policy, allowedUsers: [] } })
  expect((await revoked.confirm(f.request, f.consent)).status).toBe("ignored")
  expect(f.posts).toEqual([])
})

test("a recalled request cannot be approved or dispatched afterwards", async () => {
  const f = await fixture(); await f.portal().receive(f.request)
  await f.portal().receive({ post_type: "notice", notice_type: "friend_recall", self_id: "10001", user_id: "20001", message_id: "cross" })
  expect((await f.portal().confirm(f.request, f.consent)).status).toBe("recalled")
  expect(f.posts).toEqual([])
})

test("lost acknowledgement and unknown approved handoff reconcile without resubmitting", async () => {
  for (const unknown of [false, true]) {
    const f = await fixture(); f.configure({ lost: true, unknown }); await f.portal().receive(f.request)
    expect((await f.portal().confirm(f.request, f.consent)).status).toBe(unknown ? "uncertain" : "steered")
    await f.portal().bind(scope)
    expect((await f.portal().confirm(f.request, f.consent)).status).toBe(unknown ? "uncertain" : "steered")
    expect(f.posts).toHaveLength(1)
  }
})

test("consent is not admission: recovery before the origin exists can hand off once, but unknown origin writes never replay", async () => {
  for (const retained of [false, true]) {
    const f = await fixture(); await f.portal().receive(f.request)
    const interrupted = createPortal({ policy, session: f.session, storage: { ...f.storage, insert: async (key, value) => {
      if (key !== "origin:" + originKey(scope, "cross")) return f.storage.insert(key, value)
      if (retained) await f.storage.insert(key, value)
      throw new Error("Synthetic process interruption at origin write")
    } } })
    await expect(interrupted.confirm(f.request, f.consent)).rejects.toThrow("interruption")
    expect(f.posts).toEqual([])
    expect((await f.portal().receive(f.request)).status).toBe(retained ? "uncertain" : "steered")
    expect((await f.portal().confirm(f.request, f.consent)).status).toBe(retained ? "uncertain" : "steered")
    expect(f.posts).toHaveLength(retained ? 0 : 1)
  }
})
