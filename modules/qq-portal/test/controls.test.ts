import { expect, test } from "bun:test"
import { createPortal, type Backend, type Target } from "../src"
import { originKey, scopeKey, type Scope } from "../src/routing"
import type { Native } from "../src/target"

const policy = { botID: "10001", allowedUsers: ["20001", "20002"], allowedGroups: ["30001"] }
const scope: Scope = { botID: policy.botID, kind: "private", peerID: "20001" }
const first: Target = { kind: "session", sessionID: "ses_first" }
const second: Target = { kind: "session", sessionID: "ses_second" }
const remote: Target = { kind: "backend", ref: { backendID: "native", threadID: "thread_first" } }
const raw = (messageID: string, text: string, extra: Record<string, unknown> = {}, quote?: string) => ({
  post_type: "message", message_type: "private", self_id: policy.botID, user_id: "20001", message_id: messageID,
  message: [...(quote ? [{ type: "reply", data: { id: quote } }] : []), { type: "text", data: { text } }], ...extra,
})
function fixture() {
  const values = new Map<string, Parameters<Parameters<typeof createPortal>[0]["storage"]["set"]>[1]>()
  const reads: string[] = [], writes: string[] = [], cancelled: string[] = [], sent: string[] = [], nativeControls: unknown[] = []
  let failBinding = false, failCancel = false, failInsert = false, mismatch = false
  const pending = new Map<string, string>([["msg_first", "Private pending body"]])
  const storage = {
    get: async (key: string) => values.get(key),
    set: async (key: string, value: Parameters<typeof values.set>[1]) => { writes.push(key); values.set(key, value); if (failBinding) throw new Error("lost write acknowledgment") },
    insert: async (key: string, value: Parameters<typeof values.set>[1]) => { if (failInsert) throw new Error("storage unavailable"); if (values.has(key)) return false; values.set(key, value); return true },
  }
  const session = {
    list: async () => { reads.push("list"); return { data: [{ id: "ses_first", title: "First" }, { id: "ses_second", title: "Second" }], cursor: {} } },
    get: async ({ sessionID }: { sessionID: string }) => { reads.push("get:" + sessionID); return { id: mismatch ? "ses_wrong" : sessionID } },
    prompt: async ({ sessionID, id, text }: { sessionID: string; id: string; text: string }) => { sent.push(text); pending.set(id, text); return { id, sessionID, type: "user" } },
    message: { get: async () => { throw new Error("No history") } },
    inbox: {
      list: async ({ sessionID }: { sessionID: string }) => { reads.push("queue:" + sessionID); return [...pending].map(([id, text]) => ({ sessionID, id, type: "user", payload: { text }, time: { created: 1 }, delivery: "queue" })) },
      cancel: async ({ inboxID }: { inboxID: string }) => { cancelled.push(inboxID); pending.delete(inboxID); if (failCancel) throw new Error("lost cancel acknowledgment") },
      update: async () => { throw new Error("Unexpected queue update") },
    },
  } as unknown as Native
  const backend: { -readonly [K in keyof Backend]: Backend[K] } = {
    query: async (input) => ({ thread: { id: "threadID" in input.query ? input.query.threadID : "" } }),
    threads: async ({ backendID }) => ({ items: [{ ref: { backendID, threadID: "thread_first" }, title: "Remote", state: "idle" }], nextCursor: "more" }),
    execution: async ({ ref }) => ({ thread: { ref: mismatch ? { ...ref, threadID: "wrong" } : ref, title: "Remote", state: "running" }, queue: [{ inputID: "msg_remote", nativeID: "queue-native", text: "Remote pending", partial: false }], nextCursor: "more" }),
    send: async () => { throw new Error("Control must not send native input") },
    reconcile: async () => { throw new Error("Control must not reconcile AI admission") },
    control: async (input) => { nativeControls.push(input); return { status: "applied" } },
  }
  values.set("binding:" + scopeKey(scope), first)
  const portal = (enabled = true, users = ["20001"], backends = ["native"]) => createPortal({ storage, session, backend, policy,
    ...(enabled ? { controls: { allowedUsers: users, backendIDs: backends } } : {}) })
  return { values, reads, writes, cancelled, sent, nativeControls, pending, portal, storage, session, backend,
    configure: (flags: { binding?: boolean; cancel?: boolean; insert?: boolean; mismatch?: boolean }) => {
      failBinding = flags.binding ?? false; failCancel = flags.cancel ?? false; failInsert = flags.insert ?? false; mismatch = flags.mismatch ?? false
    } }
}

test("controls remain opt-in; recognized commands never become AI input", async () => {
  const f = fixture()
  expect(await f.portal(false).receive(raw("list", "/CODEX LIST"))).toEqual({ status: "command", action: "list", arguments: "" })
  expect(f.reads).toEqual([]); expect(f.sent).toEqual([])
})

test("task allowlisting does not grant remote controls; outsiders and groups still need their normal authorization and at", async () => {
  const f = fixture()
  expect(await f.portal().receive(raw("forbidden", "/bind ses_second", { user_id: "20002" }))).toMatchObject({ status: "control", result: { kind: "forbidden" } })
  expect((await f.portal().receive(raw("outside", "/bind ses_second", { user_id: "99999" }))).status).toBe("ignored")
  expect((await f.portal().receive(raw("group", "/bind ses_second", { message_type: "group", group_id: "30001" }))).status).toBe("ignored")
  expect(f.reads).toEqual([]); expect(f.writes).toEqual([]); expect(f.sent).toEqual([])
})

test("authorized list reads ordinary and explicitly configured whole backends without generating work", async () => {
  const f = fixture()
  expect(await f.portal().receive(raw("list", "/List"))).toMatchObject({ status: "control", result: { kind: "conversations", incomplete: true,
    items: [{ target: first, title: "First" }, { target: second, title: "Second" }, { target: remote, title: "Remote" }] } })
  expect((await f.portal().receive(raw("list", "/List")))).toMatchObject({ duplicate: true })
  expect(f.writes).toEqual([]); expect(f.sent).toEqual([])
})

test("binding validates the exact public target and concurrent redelivery writes it only once", async () => {
  const f = fixture(), request = raw("bind", "/CoDeX Bind SeSsIoN ses_second")
  const replies = await Promise.all(Array.from({ length: 8 }, () => f.portal().receive(request)))
  expect(replies.filter((row) => row.status === "control" && row.result.kind === "bound").length).toBeGreaterThanOrEqual(1)
  expect(f.reads).toEqual(["get:ses_second"]); expect(f.writes).toEqual(["binding:" + scopeKey(scope)])
  expect(f.values.get("binding:" + scopeKey(scope))).toEqual(second)
  await f.portal().bind(scope, first)
  expect(await f.portal().receive(request)).toMatchObject({ duplicate: true, result: { kind: "bound", target: second } })
  expect(f.values.get("binding:" + scopeKey(scope))).toEqual(first)
})

test("lost binding acknowledgment persists an uncertain intent and never rewrites a later binding after restart", async () => {
  const f = fixture(); f.configure({ binding: true })
  const request = raw("bind", "/bind ses_second")
  expect(await f.portal().receive(request)).toMatchObject({ result: { kind: "uncertain" } })
  f.configure({}); f.values.set("binding:" + scopeKey(scope), first)
  expect(await f.portal().receive(request)).toMatchObject({ duplicate: true, result: { kind: "uncertain" } })
  expect(f.writes).toHaveLength(1); expect(f.values.get("binding:" + scopeKey(scope))).toEqual(first)
  expect(JSON.stringify([...f.values])).not.toContain("/bind")
})

test("unbind duplicates return the historical receipt without unbinding a new selection", async () => {
  const f = fixture(), request = raw("unbind", "/UNBIND")
  expect(await f.portal().receive(request)).toMatchObject({ result: { kind: "unbound-applied" } })
  await f.portal().bind(scope, second)
  expect(await f.portal().receive(request)).toMatchObject({ duplicate: true, result: { kind: "unbound-applied" } })
  expect(f.values.get("binding:" + scopeKey(scope))).toEqual(second)
})

test("queue and status observe live native state and never persist queue bodies or infer ordinary execution", async () => {
  const f = fixture()
  expect(await f.portal().receive(raw("queue", "/queue"))).toMatchObject({ result: { kind: "queue", target: first, items: [{ inputID: "msg_first", text: "Private pending body" }], incomplete: false } })
  expect(await f.portal().receive(raw("status", "/STATUS"))).toMatchObject({ result: { kind: "status", target: first } })
  f.values.set("binding:" + scopeKey(scope), remote)
  expect(await f.portal().receive(raw("remote", "/codex queue"))).toMatchObject({ result: { kind: "queue", target: remote, state: "running", incomplete: true } })
  expect(JSON.stringify([...f.values])).not.toContain("pending body")
  expect(f.sent).toEqual([]); expect(f.nativeControls).toEqual([])
})

test("unqueue freezes a concrete input and never cancels a different queue after rebind or advancement", async () => {
  const f = fixture(), request = raw("cancel", "/Unqueue msg_first")
  expect(await f.portal().receive(request)).toMatchObject({ result: { kind: "withdraw-requested", target: first, inputID: "msg_first" } })
  f.pending.set("msg_successor", "Successor"); f.values.set("binding:" + scopeKey(scope), second)
  expect(await f.portal().receive(request)).toMatchObject({ duplicate: true, result: { kind: "withdraw-requested", target: first } })
  expect(f.cancelled).toEqual(["msg_first"]); expect(f.pending.has("msg_successor")).toBe(true)
  expect(await f.portal().receive(raw("index", "/unqueue 1"))).toMatchObject({ result: { kind: "selection-required" } })
})

test("unknown withdrawal acknowledgments are not replayed even if another pending item appears", async () => {
  const f = fixture(); f.configure({ cancel: true })
  const request = raw("cancel", "/unqueue msg_first")
  expect(await f.portal().receive(request)).toMatchObject({ result: { kind: "uncertain" } })
  f.configure({}); f.pending.set("msg_first", "Reappeared native item")
  expect(await f.portal().receive(request)).toMatchObject({ duplicate: true, result: { kind: "uncertain" } })
  expect(f.cancelled).toEqual(["msg_first"]); expect(f.pending.has("msg_first")).toBe(true)
})

test("quoted unqueue uses the original same-target task and refuses another conversation", async () => {
  const f = fixture(), portal = f.portal()
  const parent = await portal.receive(raw("parent", "Actual task"))
  if (parent.status !== "accepted") throw new Error("Task admission expected")
  expect(await portal.receive(raw("cancel", "/unqueue", {}, "parent"))).toMatchObject({ result: { kind: "withdraw-requested", inputID: parent.inputID } })
  await portal.bind(scope, second)
  expect(await portal.receive(raw("cross", "/unqueue", {}, "parent"))).toMatchObject({ result: { kind: "conflict" } })
  expect(f.cancelled).toEqual([parent.inputID])
})

test("whole-backend unqueue uses the actual native queue ID and unauthorized backends cannot be bound", async () => {
  const f = fixture(); f.values.set("binding:" + scopeKey(scope), remote)
  expect(await f.portal().receive(raw("cancel", "/unqueue msg_remote"))).toMatchObject({ result: { kind: "withdraw-requested", target: remote } })
  expect(f.nativeControls).toEqual([{ backendID: "native", control: { action: "withdraw", threadID: "thread_first", nativeID: "queue-native" } }])
  expect(await f.portal().receive(raw("bind", "/bind backend other thread_first"))).toMatchObject({ result: { kind: "forbidden" } })
  expect(f.sent).toEqual([])
})

test("conflicting envelopes cannot switch between control and model input, including concurrent first arrival", async () => {
  const f = fixture()
  const responses = await Promise.all([f.portal().receive(raw("same", "/bind ses_second")), f.portal().receive(raw("same", "Must not reinterpret"))])
  expect(responses.some((row) => row.status === "conflict")).toBe(true)
  expect(f.writes.length + f.sent.length).toBe(1)
  expect(await f.portal().receive(raw("same", "/unbind"))).toMatchObject({ status: "conflict" })
})

test("recognized unsupported and malformed commands never fall through to AI", async () => {
  const f = fixture()
  for (const [index, text] of ["/stop", "/model x", "/queue task body", "/bind 1", "/unbind extra"].entries()) {
    expect(await f.portal().receive(raw("unsupported_" + index, text))).toMatchObject({ status: "control", result: { kind: text.startsWith("/bind") ? "selection-required" : text.startsWith("/unbind") ? "invalid" : "unsupported" } })
  }
  expect(f.sent).toEqual([]); expect(f.cancelled).toEqual([]); expect(f.writes).toEqual([])
})

test("storage failure and recall-before-delivery never execute a control", async () => {
  const f = fixture(); f.configure({ insert: true })
  expect(await f.portal().receive(raw("failure", "/bind ses_second"))).toEqual({ status: "uncertain" })
  f.configure({})
  await f.portal().receive({ post_type: "notice", notice_type: "friend_recall", self_id: policy.botID, user_id: "20001", message_id: "recalled" })
  expect((await f.portal().receive(raw("recalled", "/unbind"))).status).toBe("recalled")
  expect(f.writes).toEqual([]); expect(f.sent).toEqual([])
})

test("malformed native identities and persisted control receipts fail closed", async () => {
  const f = fixture(); f.configure({ mismatch: true })
  expect(await f.portal().receive(raw("bind", "/bind ses_second"))).toMatchObject({ result: { kind: "uncertain" } })
  f.values.set("binding:" + scopeKey(scope), remote)
  expect(await f.portal().receive(raw("queue", "/queue"))).toMatchObject({ result: { kind: "unavailable", target: remote } })
  f.configure({})
  await f.portal().receive(raw("unbind", "/unbind"))
  f.values.set("control-receipt:" + originKey(scope, "unbind"), { kind: "bound", target: remote })
  expect(await f.portal().receive(raw("unbind", "/unbind"))).toMatchObject({ result: { kind: "uncertain" } })
})

test("an unavailable optional backend leaves ordinary conversation browsing usable", async () => {
  const f = fixture()
  f.backend.threads = async () => { throw new Error("Optional backend disconnected") }
  expect(await f.portal().receive(raw("list", "/list"))).toMatchObject({ result: { kind: "conversations",
    items: [{ target: first }, { target: second }], unavailable: ["native"] } })
  expect(f.sent).toEqual([])
})

test("revoking control or backend grants blocks old write receipts without changing binding or queue", async () => {
  const f = fixture(), request = raw("bind", "/bind backend native thread_first")
  expect(await f.portal().receive(request)).toMatchObject({ result: { kind: "bound", target: remote } })
  expect(await f.portal(true, []).receive(request)).toMatchObject({ result: { kind: "forbidden" } })
  expect(await f.portal(true, ["20001"], []).receive(request)).toMatchObject({ result: { kind: "forbidden" } })
  expect(f.writes).toHaveLength(1); expect(f.nativeControls).toEqual([])
})

test("a message already accepted as an ordinary task cannot be reinterpreted as a command", async () => {
  const f = fixture()
  expect((await f.portal().receive(raw("task", "Original user input"))).status).toBe("accepted")
  expect((await f.portal().receive(raw("task", "/unbind")))).toEqual({ status: "conflict" })
  expect(f.writes).toEqual([]); expect(f.sent).toEqual(["Original user input"])
})

test("later activation or permission grants cannot execute an old classified or refused write command", async () => {
  const f = fixture(), disabled = raw("disabled", "/bind ses_second"), refused = raw("refused", "/unbind")
  expect((await f.portal(false).receive(disabled)).status).toBe("command")
  expect(await f.portal(true, []).receive(refused)).toMatchObject({ result: { kind: "forbidden" } })
  expect(await f.portal().receive(disabled)).toMatchObject({ duplicate: true, result: { kind: "uncertain" } })
  expect(await f.portal().receive(refused)).toMatchObject({ duplicate: true, result: { kind: "uncertain" } })
  expect(f.writes).toEqual([]); expect(f.reads).toEqual([]); expect(f.sent).toEqual([])
})
