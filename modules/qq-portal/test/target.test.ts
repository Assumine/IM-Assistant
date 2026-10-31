import { expect, test } from "bun:test"
import { createPortal, type Target, type Backend } from "../src"
import { fingerprint, inputID, originKey, scopeKey, type Message } from "../src/routing"
import { target } from "../src/target"

const policy = { botID: "10001", allowedUsers: ["20001"], allowedGroups: [] }
const scope = { botID: "10001", kind: "private" as const, peerID: "20001" }
const destination: Target = { kind: "backend", ref: { backendID: "native", threadID: "same-id" } }
const raw = (id: string, quote?: string) => ({ post_type: "message", message_type: "private", self_id: "10001", user_id: "20001", message_id: id,
  message: [...(quote ? [{ type: "reply", data: { id: quote } }] : []), { type: "text", data: { text: "Body " + id } }] })
const decoded = (id: string): Message => ({ scope, actorID: "20001", messageID: id, text: "Body " + id, mentions: [] })

function fixture() {
  const values = new Map<string, Parameters<Parameters<typeof createPortal>[0]["storage"]["set"]>[1]>()
  const sends: unknown[] = [], controls: unknown[] = [], reconciles: unknown[] = []
  let nativeSessionReads = 0
  const forbidden = async () => { nativeSessionReads++; throw new Error("Session API must not handle a native thread") }
  const backend: { -readonly [K in keyof Backend]: Backend[K] } = {
    query: async (input) => ({ thread: { id: "threadID" in input.query ? input.query.threadID : "" } }),
    execution: async ({ ref }) => ({ thread: { ref, title: "Native", state: "idle" }, queue: [] }),
    send: async (input) => { sends.push(input); return { status: "accepted", ref: input.ref, inputID: input.inputID, receipt: { nativeID: "native-queue", kind: "queued" } } },
    reconcile: async (input) => { reconciles.push(input); return { status: "accepted", ...input, receipt: { nativeID: "native-queue", kind: "queued" } } },
    control: async (input) => { controls.push(input); return { status: "applied" } },
  }
  const storage = {
    get: async (key: string) => values.get(key),
    set: async (key: string, value: Parameters<typeof values.set>[1]) => { values.set(key, value) },
    insert: async (key: string, value: Parameters<typeof values.set>[1]) => { if (values.has(key)) return false; values.set(key, value); return true },
  }
  const session = { get: forbidden, prompt: forbidden, message: { get: forbidden }, inbox: { list: forbidden, cancel: forbidden, update: forbidden } }
  return { values, backend, storage, session, sends, controls, reconciles, reads: () => nativeSessionReads,
    portal: () => createPortal({ policy, storage, session, backend }) }
}

test("native target stays explicit, freezes through rebinding, and duplicates only reconcile", async () => {
  const f = fixture(), portal = f.portal()
  await portal.bind(scope, destination)
  const admitted = await portal.receive(raw("one"))
  expect(admitted.status === "accepted" && admitted.target).toEqual(destination)
  expect(admitted.status === "accepted" && admitted.sessionID).toBeUndefined()
  await portal.bind(scope, { kind: "backend", ref: { backendID: "other", threadID: "same-id" } })
  expect((await portal.receive(raw("one"))).status).toBe("accepted")
  expect(f.sends).toHaveLength(1)
  expect(f.reconciles).toEqual([{ ref: destination.ref, inputID: inputID(decoded("one")) }])
  expect(f.reads()).toBe(0)
})

test("legacy scalar binding and old origin remain readable without rewriting metadata", async () => {
  const f = fixture(), message = decoded("old")
  const origin = { sessionID: "ses_old", inputID: inputID(message), actorID: "20001", fingerprint: fingerprint(message) }
  f.values.set("binding:" + scopeKey(scope), "ses_old")
  f.values.set("origin:" + originKey(scope, "old"), origin)
  const portal = createPortal({ policy, storage: f.storage, backend: f.backend,
    session: { ...f.session, inbox: { ...f.session.inbox, list: async () => [] }, message: { get: async () => { throw new Error("Already removed") } } } })
  expect((await portal.receive(raw("old"))).status).toBe("uncertain")
  expect(f.values.get("origin:" + originKey(scope, "old"))).toEqual(origin)
  expect(f.sends).toEqual([])
  expect(f.reads()).toBe(0)
})

test("missing or mismatched backend cannot bind or fall through to a Session", async () => {
  const f = fixture()
  const portal = createPortal({ policy, storage: f.storage, session: f.session })
  await expect(portal.bind(scope, destination)).rejects.toThrow("unavailable")
  expect(f.values.size).toBe(0)
  f.values.set("binding:" + scopeKey(scope), destination)
  expect((await portal.receive(raw("unavailable"))).status).toBe("uncertain")
  f.backend.query = async () => ({ thread: { id: "wrong" } })
  await expect(f.portal().bind(scope, destination)).rejects.toThrow("Wrong native")
  expect(f.reads()).toBe(0)
})

test("references compare backend ownership as well as thread ID and cannot escape through a reply alias", async () => {
  const f = fixture(), portal = f.portal()
  await portal.bind(scope, destination)
  await portal.receive(raw("source"))
  await portal.linkReply(decoded("source"), "outgoing")
  expect(await portal.receive(raw("same", "outgoing"))).toEqual({ status: "blocked", reason: "quoted-adjustment-unavailable" })
  await portal.bind(scope, { kind: "backend", ref: { backendID: "other", threadID: "same-id" } })
  expect(await portal.receive(raw("cross", "outgoing"))).toEqual({ status: "blocked", reason: "cross-session-confirmation-required" })
  expect(f.sends).toHaveLength(1)
})

test("recall traverses native queue pages and uses only the matching submission ID", async () => {
  const f = fixture(), portal = f.portal()
  await portal.bind(scope, destination)
  await portal.receive(raw("pending"))
  f.backend.execution = async ({ ref, cursor }) => ({ thread: { ref, title: "Native", state: "running" },
    queue: cursor ? [{ inputID: inputID(decoded("pending")), nativeID: "actual-native-ID", text: "", partial: false }] : [], nextCursor: cursor ? undefined : "next" })
  expect(await portal.receive({ post_type: "notice", notice_type: "friend_recall", self_id: "10001", user_id: "20001", message_id: "pending" })).toEqual({ status: "withdrawn" })
  expect(f.controls).toEqual([{ backendID: "native", control: { action: "withdraw", threadID: "same-id", nativeID: "actual-native-ID" } }])
  expect(f.reads()).toBe(0)
})

test("delivered recall leaves native execution untouched and a repeated cursor is uncertain", async () => {
  const f = fixture(), portal = f.portal()
  await portal.bind(scope, destination)
  await portal.receive(raw("done"))
  const recall = { post_type: "notice", notice_type: "friend_recall", self_id: "10001", user_id: "20001", message_id: "done" }
  expect(await portal.receive(recall)).toEqual({ status: "unchanged" })
  f.backend.execution = async ({ ref }) => ({ thread: { ref, title: "Native", state: "running" }, queue: [], nextCursor: "cycle" })
  expect(await portal.receive(recall)).toEqual({ status: "uncertain" })
  expect(f.controls).toEqual([])
})

test("native unknown delivery does not resend, and a definitive refusal is reported accurately", async () => {
  const f = fixture(), portal = f.portal()
  await portal.bind(scope, destination)
  f.backend.send = async (input) => { f.sends.push(input); return { status: "uncertain", ref: input.ref, inputID: input.inputID } }
  f.backend.reconcile = async (input) => ({ status: "uncertain", ...input })
  expect((await portal.receive(raw("unknown"))).status).toBe("uncertain")
  expect((await portal.receive(raw("unknown"))).status).toBe("uncertain")
  expect(f.sends).toHaveLength(1)
  f.backend.send = async (input) => ({ status: "rejected", reason: "not-accepted", ref: input.ref, inputID: input.inputID })
  expect(await portal.receive(raw("refused"))).toEqual({ status: "rejected", reason: "not-accepted" })
})

test("malformed and mixed conversation targets fail closed before any native API", () => {
  for (const value of ["", { kind: "backend", ref: { backendID: "opencode", threadID: "ses_x" } },
    { kind: "backend", ref: { backendID: "native", threadID: "x", path: "/private" } },
    { kind: "session", sessionID: "ses_x", ref: destination.ref }, { kind: "backend", ref: { backendID: "native", threadID: "../secret" } }])
    expect(() => target(value)).toThrow("Invalid QQ")
})

test("recalling an acknowledged reply alias cannot cancel its originating pending task", async () => {
  const f = fixture(), portal = f.portal()
  await portal.bind(scope, destination)
  await portal.receive(raw("original"))
  await portal.linkReply(decoded("original"), "bot-receipt")
  f.backend.execution = async ({ ref }) => ({ thread: { ref, title: "Native", state: "running" },
    queue: [{ inputID: inputID(decoded("original")), nativeID: "pending-original", text: "", partial: false }] })
  const recall = { post_type: "notice", notice_type: "friend_recall", self_id: "10001", user_id: "20001" }
  expect(await portal.receive({ ...recall, message_id: "bot-receipt" })).toEqual({ status: "unchanged" })
  expect(f.controls).toEqual([])
  expect(await portal.receive({ ...recall, message_id: "original" })).toEqual({ status: "withdrawn" })
  expect(f.controls).toHaveLength(1)
})

function sessionFixture() {
  const f = fixture(), rootID = inputID(decoded("parent")), applied = new Set<string>()
  const calls: { sessionID: string; inboxID: string; amendmentID: string; text: string }[] = []
  const original = { target: { kind: "session" as const, sessionID: "ses_pending" }, inputID: rootID, actorID: "20001", fingerprint: fingerprint(decoded("parent")) }
  f.values.set("binding:" + scopeKey(scope), "ses_pending")
  f.values.set("origin:" + originKey(scope, "parent"), original)
  let pending = true, fail = false, acknowledge = true, conflict = false
  const session = { ...f.session, inbox: { ...f.session.inbox,
    list: async () => pending ? [{ id: rootID, sessionID: "ses_pending", time: { created: 1 }, type: "user" as const, payload: { text: "parent" }, delivery: "queue" as const }] : [],
    append: async (input: typeof calls[number]) => {
      calls.push(input)
      if (conflict) throw { _tag: "ConflictError", message: "Pending input changed" }
      if (acknowledge) applied.add(input.amendmentID)
      if (fail) throw new Error("Lost append receipt")
      return { sessionID: input.sessionID, inboxID: input.inboxID, amendmentID: input.amendmentID, status: "applied" as const }
    },
    amendment: async (input: { sessionID: string; inboxID: string; amendmentID: string }) => ({ ...input, status: applied.has(input.amendmentID) ? "applied" as const : "unknown" as const }),
  } }
  return { ...f, rootID, original, calls, portal: createPortal({ policy, storage: f.storage, session }),
    configure: (state: { pending?: boolean; fail?: boolean; acknowledge?: boolean; conflict?: boolean }) => {
      pending = state.pending ?? pending; fail = state.fail ?? fail; acknowledge = state.acknowledge ?? acknowledge; conflict = state.conflict ?? conflict
    } }
}

test("a quoted pending Session input appends under the parent ID instead of sending a new task", async () => {
  const f = sessionFixture()
  const result = await f.portal.receive(raw("extra", "parent"))
  expect(result).toMatchObject({ status: "amended", inputID: f.rootID, amendmentID: inputID(decoded("extra")), duplicate: false })
  expect(f.calls).toEqual([{ sessionID: "ses_pending", inboxID: f.rootID, amendmentID: inputID(decoded("extra")), text: "Body extra" }])
  expect(f.reads()).toBe(0)
  expect(f.sends).toEqual([])
})

test("a lost amendment acknowledgement reconciles the frozen Session after rebinding without appending twice", async () => {
  const f = sessionFixture()
  f.configure({ fail: true })
  expect((await f.portal.receive(raw("extra", "parent"))).status).toBe("amended")
  f.values.set("binding:" + scopeKey(scope), { kind: "backend", ref: { backendID: "other", threadID: "another" } })
  expect(await f.portal.receive(raw("extra", "parent"))).toMatchObject({ status: "amended", target: f.original.target, duplicate: true })
  expect(f.calls).toHaveLength(1)
})

test("delivered parents and native append conflicts never route a quote to another task", async () => {
  const f = sessionFixture()
  f.configure({ pending: false })
  expect(await f.portal.receive(raw("extra", "parent"))).toEqual({ status: "blocked", reason: "quoted-task-not-pending" })
  expect(f.calls).toEqual([])
  f.configure({ pending: true, conflict: true })
  expect(await f.portal.receive(raw("extra", "parent"))).toEqual({ status: "blocked", reason: "quoted-task-not-pending" })
  expect(f.calls).toHaveLength(1)
  expect(f.reads()).toBe(0)
})

test("an unknown append is not repeated and recalling its supplement never cancels the parent", async () => {
  const f = sessionFixture()
  f.configure({ fail: true, acknowledge: false })
  expect((await f.portal.receive(raw("extra", "parent"))).status).toBe("uncertain")
  expect((await f.portal.receive(raw("extra", "parent"))).status).toBe("uncertain")
  expect(f.calls).toHaveLength(1)
  expect(await f.portal.receive({ post_type: "notice", notice_type: "friend_recall", self_id: "10001", user_id: "20001", message_id: "extra" })).toEqual({ status: "unchanged" })
  expect(f.reads()).toBe(0)
})
