import { expect, test } from "bun:test"
import { createPortal, type Backend, type Scope, type Source, type Target } from "../src"
import { decode, fingerprint, inputID, originKey, scopeKey } from "../src/routing"
import { sourceKey } from "../src/sources"

const policy = { botID: "10001", allowedUsers: ["20001", "20002"], allowedGroups: ["30001", "30002"] }
const peer: Scope = { botID: "10001", kind: "private", peerID: "20001" }
const destination: Target = { kind: "backend", ref: { backendID: "native", threadID: "same-id" } }
const raw = (id: string, scope = peer) => ({ post_type: "message", message_type: scope.kind, self_id: scope.botID,
  user_id: scope.kind === "private" ? scope.peerID : "20001", group_id: scope.kind === "group" ? scope.peerID : undefined, message_id: id,
  message: [...(scope.kind === "group" ? [{ type: "at", data: { qq: scope.botID } }] : []), { type: "text", data: { text: "Private body " + id } }] })
const message = (id: string, scope = peer) => {
  const event = decode(raw(id, scope), { ...policy, botID: scope.botID })
  if (event.kind !== "message") throw new Error("Expected message")
  return event.message
}
const source = (id: string, scope = peer): Source => ({ scope, messageID: id, actorID: scope.kind === "private" ? scope.peerID : "20001" })

function fixture() {
  type Value = Parameters<Parameters<typeof createPortal>[0]["storage"]["set"]>[1]
  const values = new Map<string, Value>()
  const sends: string[] = [], reconciles: string[] = []
  const accepted = new Set<string>()
  const storage = {
    get: async (key: string) => values.get(key),
    set: async (key: string, value: Value) => { values.set(key, value) },
    insert: async (key: string, value: Value) => { if (values.has(key)) return false; values.set(key, value); return true },
  }
  const backend: { -readonly [K in keyof Backend]: Backend[K] } = {
    query: async (request) => ({ thread: { id: "threadID" in request.query ? request.query.threadID : "" } }),
    send: async (request) => {
      sends.push(request.inputID)
      expect(values.has(sourceKey({ kind: "backend", ref: request.ref }, request.inputID))).toBe(true)
      accepted.add(request.inputID)
      return { ...request, status: "accepted", receipt: { kind: "queued", nativeID: "native-queue" } }
    },
    reconcile: async (request) => { reconciles.push(request.inputID); return accepted.has(request.inputID)
      ? { ...request, status: "accepted", receipt: { kind: "queued", nativeID: "native-queue" } } : { ...request, status: "uncertain" } },
    execution: async () => { throw new Error("Source lookup must not poll execution") },
    control: async () => { throw new Error("Source lookup must not control execution") },
  }
  const forbidden = async () => { throw new Error("Whole backend must not access a Session") }
  const session = { get: forbidden, prompt: forbidden, message: { get: forbidden }, inbox: { list: forbidden, cancel: forbidden, update: forbidden } }
  const portal = (current = policy, store = storage) => createPortal({ policy: current, storage: store, session, backend })
  return { values, storage, backend, sends, reconciles, accepted, session, portal }
}

test("source envelopes are durable before native handoff and contain neither message bodies nor task state", async () => {
  const f = fixture(), portal = f.portal()
  await portal.bind(peer, destination)
  await portal.receive(raw("original"))
  const id = inputID(message("original"))
  expect(await portal.sourceFor(destination, id)).toEqual({ status: "found", source: source("original") })
  const stored = JSON.stringify([...f.values.values()])
  expect(stored).not.toContain("Private body")
  expect(stored).not.toContain("queued")
  expect(f.sends).toEqual([id])
})

test("restart, unbinding and rebinding never change the task origin or first/final reference source", async () => {
  const f = fixture(), portal = f.portal()
  await portal.bind(peer, destination)
  await portal.receive(raw("original"))
  await portal.bind(peer)
  const restored = f.portal(), id = inputID(message("original"))
  const found = await restored.sourceFor(destination, id)
  expect(found).toEqual({ status: "found", source: source("original") })
  if (found.status !== "found") throw new Error("Source missing")
  await restored.linkReply(found.source, "first-reply")
  await restored.bind(peer, { kind: "backend", ref: { backendID: "other", threadID: "same-id" } })
  await restored.linkReply(found.source, "final-reply")
  expect(await restored.sourceFor(destination, id)).toEqual(found)
  expect(f.sends).toHaveLength(1)
  for (const alias of ["first-reply", "final-reply"]) expect(f.values.get("origin:" + originKey(peer, alias))).toEqual(f.values.get("origin:" + originKey(peer, "original")))
})

test("same message ID in private, different groups and different bots remains isolated", async () => {
  const f = fixture()
  const scopes: Scope[] = [peer, { ...peer, kind: "group", peerID: "30001" }, { ...peer, kind: "group", peerID: "30002" }, { ...peer, botID: "10002" }]
  for (const scope of scopes) {
    const portal = f.portal({ ...policy, botID: scope.botID })
    await portal.bind(scope, destination)
    await portal.receive(raw("same", scope))
    expect(await portal.sourceFor(destination, inputID(message("same", scope)))).toEqual({ status: "found", source: source("same", scope) })
  }
  expect(f.sends).toHaveLength(4)
  const before = f.reconciles.length
  expect(await f.portal().sourceFor(destination, inputID(message("same", scopes[3])))).toEqual({ status: "forbidden" })
  expect(f.reconciles).toHaveLength(before)
})

test("backend ID, thread ID and Session identity are all part of reverse lookup", async () => {
  const f = fixture(), portal = f.portal(), id = inputID(message("original"))
  await portal.bind(peer, destination)
  await portal.receive(raw("original"))
  for (const wrong of [{ kind: "backend", ref: { backendID: "other", threadID: "same-id" } },
    { kind: "backend", ref: { backendID: "native", threadID: "different" } }, { kind: "session", sessionID: "same-id" }] satisfies Target[])
    expect(await portal.sourceFor(wrong, id)).toEqual({ status: "missing" })
  expect(f.reconciles).toEqual([])
})

test("removing a member or group permission prevents source resolution before any native query", async () => {
  const f = fixture(), scope: Scope = { ...peer, kind: "group", peerID: "30001" }, portal = f.portal()
  await portal.bind(scope, destination)
  await portal.receive(raw("original", scope))
  for (const current of [{ ...policy, allowedUsers: [] }, { ...policy, allowedGroups: [] }]) {
    expect(await f.portal(current).sourceFor(destination, inputID(message("original", scope)))).toEqual({ status: "forbidden" })
    await expect(f.portal(current).linkReply(source("original", scope), "forbidden-outgoing")).rejects.toThrow()
  }
  expect(f.reconciles).toEqual([])
  expect(f.values.has("origin:" + originKey(scope, "forbidden-outgoing"))).toBe(false)
})

test("legacy origins and reply aliases cannot manufacture missing envelopes from a current binding", async () => {
  const f = fixture(), portal = f.portal(), input = message("legacy"), id = inputID(input)
  const legacy = { sessionID: "ses_old", inputID: id, actorID: "20001", fingerprint: fingerprint(input) }
  f.values.set("origin:" + originKey(peer, "legacy"), legacy)
  f.values.set("origin:" + originKey(peer, "old-alias"), legacy)
  f.values.set("binding:" + scopeKey(peer), destination)
  const before = JSON.stringify([...f.values])
  expect(await portal.sourceFor({ kind: "session", sessionID: "ses_old" }, id)).toEqual({ status: "missing" })
  expect(await portal.sourceFor(destination, id)).toEqual({ status: "missing" })
  await expect(portal.linkReply(source("legacy"), "new-alias")).rejects.toThrow()
  expect(JSON.stringify([...f.values])).toBe(before)
  expect(f.sends).toEqual([])
})

test("a crash between origin and reverse-index writes does not submit or resend work", async () => {
  const f = fixture(), id = inputID(message("interrupted"))
  const failing = f.portal(policy, { ...f.storage, insert: async (key, value) => {
    if (key.startsWith("input-origin:")) throw new Error("Index write unavailable")
    return f.storage.insert(key, value)
  } })
  await failing.bind(peer, destination)
  await expect(failing.receive(raw("interrupted"))).rejects.toThrow("Index write unavailable")
  expect(f.sends).toEqual([])
  expect(await f.portal().sourceFor(destination, id)).toEqual({ status: "missing" })
  expect(await f.portal().receive(raw("interrupted"))).toEqual({ status: "uncertain" })
  expect(f.values.has(sourceKey(destination, id))).toBe(true)
  expect(await f.portal().sourceFor(destination, id)).toEqual({ status: "uncertain" })
  expect(f.sends).toEqual([])
})

test("a lost reverse-index write acknowledgement recovers by comparison, never native replay", async () => {
  const f = fixture(), id = inputID(message("lost-index"))
  const failing = f.portal(policy, { ...f.storage, insert: async (key, value) => {
    const inserted = await f.storage.insert(key, value)
    if (key.startsWith("input-origin:")) throw new Error("Index acknowledgment lost")
    return inserted
  } })
  await failing.bind(peer, destination)
  await expect(failing.receive(raw("lost-index"))).rejects.toThrow("acknowledgment lost")
  expect((await f.portal().receive(raw("lost-index"))).status).toBe("uncertain")
  expect(f.sends).toEqual([])
  expect(await f.portal().sourceFor(destination, id)).toEqual({ status: "uncertain" })
})

test("parallel duplicate deliveries share one immutable index and one native admission", async () => {
  const f = fixture(), portal = f.portal()
  await portal.bind(peer, destination)
  const results = await Promise.all(Array.from({ length: 12 }, () => portal.receive(raw("parallel"))))
  expect(results.some((entry) => entry.status === "accepted")).toBe(true)
  expect(f.sends).toHaveLength(1)
  expect([...f.values.keys()].filter((key) => key.startsWith("input-origin:"))).toHaveLength(1)
  expect(await portal.sourceFor(destination, inputID(message("parallel")))).toEqual({ status: "found", source: source("parallel") })
})

test("corrupt or mismatched reverse pointers fail closed and cannot overwrite a source", async () => {
  for (const corrupt of [source("other"), { ...source("original"), actorID: "20002" }, { ...source("original"), scope: { ...peer, peerID: "20002" } }, null]) {
    const f = fixture(), portal = f.portal(), id = inputID(message("original"))
    await portal.bind(peer, destination)
    f.values.set(sourceKey(destination, id), corrupt)
    await expect(portal.receive(raw("original"))).rejects.toThrow()
    expect(f.sends).toEqual([])
    expect(await portal.sourceFor(destination, id)).toEqual({ status: "uncertain" })
    expect(f.values.get(sourceKey(destination, id))).toEqual(corrupt)
  }
})

test("unknown and rejected handoffs expose no confirmed recipient and never cause send or resume", async () => {
  const f = fixture(), portal = f.portal(), id = inputID(message("unknown"))
  f.backend.send = async (request) => { f.sends.push(request.inputID); return { ...request, status: "uncertain" } }
  await portal.bind(peer, destination)
  expect((await portal.receive(raw("unknown"))).status).toBe("uncertain")
  expect(await portal.sourceFor(destination, id)).toEqual({ status: "uncertain" })
  await expect(portal.linkReply(source("unknown"), "not-sent")).rejects.toThrow("not confirmed")
  f.backend.reconcile = async (request) => ({ ...request, status: "rejected", reason: "not-accepted" })
  expect(await portal.sourceFor(destination, id)).toEqual({ status: "not-accepted" })
  expect(f.sends).toHaveLength(1)
})

test("alias registration validates source identity and immutable actual outgoing IDs", async () => {
  const f = fixture(), portal = f.portal()
  await portal.bind(peer, destination)
  await portal.receive(raw("first"))
  await portal.receive(raw("second"))
  for (const invalid of ["", "../message", "x".repeat(65)]) await expect(portal.linkReply(source("first"), invalid)).rejects.toThrow()
  await expect(portal.linkReply({ ...source("first"), actorID: "20002" }, "wrong-actor")).rejects.toThrow()
  await portal.linkReply(source("first"), "outgoing")
  await portal.linkReply(source("first"), "outgoing")
  await expect(portal.linkReply(source("second"), "outgoing")).rejects.toThrow("conflict")
  expect(await portal.sourceFor(destination, inputID(message("outgoing")))).toEqual({ status: "missing" })
  expect(f.sends).toHaveLength(2)
})

test("ordinary Session amendments retain the original task source rather than replacing it with the supplement or its reply", async () => {
  const f = fixture(), destination: Target = { kind: "session", sessionID: "ses_pending" }
  type Pending = Awaited<ReturnType<Parameters<typeof createPortal>[0]["session"]["prompt"]>>
  const pending: Pending[] = [], amendments = new Set<string>()
  const session: Parameters<typeof createPortal>[0]["session"] = { ...f.session,
    prompt: async (input) => {
      const item = { id: input.id!, sessionID: input.sessionID, type: "user" as const,
        payload: { text: input.text, metadata: input.metadata }, delivery: "queue" as const, time: { created: 1 } }
      pending.push(item)
      return item
    },
    inbox: { ...f.session.inbox, list: async () => pending,
      append: async (input) => { amendments.add(input.amendmentID); return { ...input, status: "applied" } },
      amendment: async (input) => ({ ...input, status: amendments.has(input.amendmentID) ? "applied" : "unknown" }),
    },
  }
  f.values.set("binding:" + scopeKey(peer), destination)
  const portal = createPortal({ policy, storage: f.storage, session })
  await portal.receive(raw("parent"))
  await portal.linkReply(source("parent"), "queued-receipt")
  const extra = { ...raw("supplement"), message: [{ type: "reply", data: { id: "queued-receipt" } }, ...raw("supplement").message] }
  expect((await portal.receive(extra)).status).toBe("amended")
  await portal.linkReply(source("supplement"), "supplement-receipt")
  expect(await portal.sourceFor(destination, inputID(message("parent")))).toEqual({ status: "found", source: source("parent") })
  expect(await portal.sourceFor(destination, inputID(message("supplement")))).toEqual({ status: "missing" })
  expect([...f.values.keys()].filter((key) => key.startsWith("input-origin:"))).toHaveLength(1)
  expect(pending).toHaveLength(1)
})

test("a non-user native Inbox ID cannot prove QQ admission or authorize a reply alias", async () => {
  const f = fixture(), destination: Target = { kind: "session", sessionID: "ses_collision" }, id = inputID(message("collision"))
  const control = { id, sessionID: destination.sessionID, type: "compaction" as const, payload: {}, time: { created: 1 }, delivery: "queue" as const }
  let prompts = 0
  const portal = createPortal({ policy, storage: f.storage, session: { ...f.session,
    prompt: async () => { prompts++; throw new Error("Native ID belongs to a control") }, inbox: { ...f.session.inbox, list: async () => [control] },
  } })
  f.values.set("binding:" + scopeKey(peer), destination)
  expect((await portal.receive(raw("collision"))).status).toBe("uncertain")
  expect((await portal.receive(raw("collision"))).status).toBe("uncertain")
  expect(await portal.sourceFor(destination, id)).toEqual({ status: "uncertain" })
  await expect(portal.linkReply(source("collision"), "not-a-task-reply")).rejects.toThrow("not confirmed")
  expect(prompts).toBe(1)
})
