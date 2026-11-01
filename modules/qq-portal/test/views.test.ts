import { expect, test } from "bun:test"
import { createPortal, type Backend, type Source, type Scope, type Target } from "../src"
import { originKey, scopeKey } from "../src/routing"
import type { Native } from "../src/target"

const policy = { botID: "10001", allowedUsers: ["20001", "20002"], allowedGroups: ["30001", "30002"] }
const peer: Scope = { botID: policy.botID, kind: "private", peerID: "20001" }
const first: Target = { kind: "session", sessionID: "ses_first" }
const second: Target = { kind: "session", sessionID: "ses_second" }
const remote: Target = { kind: "backend", ref: { backendID: "native", threadID: "thread_first" } }
const raw = (id: string, text: string, quote?: string, scope = peer, actorID = "20001") => ({
  post_type: "message", self_id: policy.botID, message_type: scope.kind, user_id: actorID, message_id: id,
  ...(scope.kind === "group" ? { group_id: scope.peerID } : {}),
  message: [...(scope.kind === "group" ? [{ type: "at", data: { qq: policy.botID } }] : []),
    ...(quote ? [{ type: "reply", data: { id: quote } }] : []), { type: "text", data: { text } }],
})
const owner = (id: string, scope = peer, actorID = "20001"): Source => ({ scope, actorID, messageID: id })
function fixture() {
  const values = new Map<string, Parameters<Parameters<typeof createPortal>[0]["storage"]["set"]>[1]>()
  const gets: string[] = [], cancelled: string[] = [], controlled: unknown[] = [], sent: unknown[] = []
  const queues = new Map<string, Map<string, string>>([["ses_first", new Map([["msg_first", "Secret pending body"], ["msg_second", "Second body"]])], ["ses_second", new Map()]])
  let catalog = ["ses_first", "ses_second"], remoteID = "native_original", failReady = false, failControl = false, incomplete = false
  const storage = {
    get: async (key: string) => values.get(key),
    set: async (key: string, value: Parameters<typeof values.set>[1]) => { values.set(key, value) },
    insert: async (key: string, value: Parameters<typeof values.set>[1]) => {
      if (failReady && key.startsWith("control-view-published:")) throw new Error("Interrupted publication")
      if (values.has(key)) return false
      values.set(key, value); return true
    },
  }
  const session = {
    list: async () => ({ data: catalog.map((id) => ({ id, title: "Secret title " + id })), cursor: incomplete ? { next: "next-page" } : {} }),
    get: async ({ sessionID }: { sessionID: string }) => { gets.push(sessionID); return { id: sessionID } },
    prompt: async (input: unknown) => { sent.push(input); throw new Error("No model input allowed") },
    message: { get: async () => { throw new Error("No model history") } },
    inbox: {
      list: async ({ sessionID }: { sessionID: string }) => [...queues.get(sessionID) ?? []].map(([id, text]) => ({ id, sessionID, type: "user", payload: { text }, delivery: "queue", time: { created: 1 } })),
      cancel: async ({ sessionID, inboxID }: { sessionID: string; inboxID: string }) => { cancelled.push(inboxID); queues.get(sessionID)?.delete(inboxID) },
      update: async () => { throw new Error("No queue rewriting") },
    },
  } as unknown as Native
  const backend: Backend = {
    query: async (input) => ({ thread: { id: "threadID" in input.query ? input.query.threadID : "" } }),
    threads: async ({ backendID }) => ({ items: [{ ref: { backendID, threadID: "thread_first" }, title: "Secret remote title", state: "running" }] }),
    execution: async ({ ref }) => ({ thread: { ref, title: "Remote", state: "running" }, queue: [{ inputID: "msg_remote", nativeID: remoteID, text: "Secret remote body", partial: false }] }),
    control: async (input) => { controlled.push(input); if (failControl) throw new Error("Unknown mutation"); return { status: input.control.action === "withdraw" && input.control.nativeID === remoteID ? "applied" : "not-found" } },
    send: async () => { throw new Error("No native AI send") }, reconcile: async () => { throw new Error("No native AI reconcile") },
  }
  values.set("binding:" + scopeKey(peer), first)
  const portal = (users = ["20001", "20002"], backendIDs = ["native"]) => createPortal({ storage, policy, session, backend, controls: { allowedUsers: users, backendIDs } })
  async function show(id: string, kind: "list" | "queue" = "list", scope = peer, actorID = "20001") {
    const value = await portal().receive(raw(id, "/" + kind, undefined, scope, actorID))
    if (value.status !== "control" || (value.result.kind !== "conversations" && value.result.kind !== "queue") || !value.result.viewID) throw new Error("View expected")
    return { result: value.result, viewID: value.result.viewID, source: owner(id, scope, actorID) }
  }
  return { values, gets, cancelled, controlled, sent, queues, storage, session, backend, portal, show,
    configure: (v: { catalog?: string[]; remoteID?: string; failReady?: boolean; failControl?: boolean; incomplete?: boolean }) => {
      if (v.catalog) catalog = v.catalog; if (v.remoteID) remoteID = v.remoteID
      failReady = v.failReady ?? false; failControl = v.failControl ?? false; incomplete = v.incomplete ?? false
    } }
}

test("unpublished or unquoted numbered selections never infer a current list", async () => {
  const f = fixture(), shown = await f.show("list")
  expect(await f.portal().receive(raw("unpublished", "/bind 1", "list"))).toMatchObject({ result: { kind: "selection-required" } })
  await f.portal().linkControlView(shown.source, shown.viewID, "list-output")
  expect(await f.portal().receive(raw("unquoted", "/bind 1"))).toMatchObject({ result: { kind: "selection-required" } })
  expect(f.gets).toEqual([]); expect(f.sent).toEqual([])
})

test("published catalog indices retain their original exact targets after reordering and restart", async () => {
  const f = fixture(), shown = await f.show("list")
  await f.portal().linkControlView(shown.source, shown.viewID, "list-output")
  f.configure({ catalog: ["ses_second", "ses_first"] })
  const request = raw("bind", "/CODEX Bind 1", "list-output")
  expect(await f.portal().receive(request)).toMatchObject({ result: { kind: "bound", target: first } })
  await f.portal().bind(peer, second)
  expect(await f.portal().receive(request)).toMatchObject({ duplicate: true, result: { kind: "bound", target: first } })
  expect(f.values.get("binding:" + scopeKey(peer))).toEqual(second)
  expect(f.gets).toEqual(["ses_first", "ses_second"])
})

test("duplicate catalog deliveries keep one immutable row order while projecting only freshly observed labels", async () => {
  const f = fixture(), shown = await f.show("list")
  f.configure({ catalog: ["ses_second"] })
  const again = await f.show("list")
  expect(again.viewID).toBe(shown.viewID)
  if (again.result.kind !== "conversations") throw new Error("Catalog expected")
  expect(again.result.items).toEqual([
    { target: first, title: "", index: 1, observed: false },
    { target: second, title: "Secret title ses_second", index: 2, observed: true },
    { target: remote, title: "Secret remote title", index: 3, observed: true },
  ])
})

test("both actual outgoing reply and original command can identify a published view without rewriting aliases", async () => {
  const f = fixture(), shown = await f.show("list")
  await f.portal().linkControlView(shown.source, shown.viewID, "list-output")
  await f.portal().linkControlView(shown.source, shown.viewID, "list-output")
  expect(await f.portal().receive(raw("bind", "/bind 2", "list"))).toMatchObject({ result: { kind: "bound", target: second } })
  const other = await f.show("other-list")
  await expect(f.portal().linkControlView(other.source, other.viewID, "list-output")).rejects.toThrow("Conflicting view alias")
  expect(await f.portal().receive(raw("bind-again", "/bind 1", "list-output"))).toMatchObject({ result: { kind: "bound", target: first } })
})

test("numbered queue withdrawal uses the old stable input after earlier rows leave the queue", async () => {
  const f = fixture(), shown = await f.show("queue", "queue")
  await f.portal().linkControlView(shown.source, shown.viewID, "queue-output")
  f.queues.get("ses_first")!.delete("msg_first")
  f.queues.get("ses_first")!.set("msg_third", "Later task")
  expect(await f.portal().receive(raw("withdraw", "/unqueue 2", "queue-output"))).toMatchObject({ result: { kind: "withdraw-requested", inputID: "msg_second", target: first } })
  expect(f.cancelled).toEqual(["msg_second"]); expect(f.queues.get("ses_first")!.has("msg_third")).toBe(true)
})

test("native selection freezes the original submission ID and cannot delete its reused client-ID successor", async () => {
  const f = fixture(); f.values.set("binding:" + scopeKey(peer), remote)
  const shown = await f.show("queue", "queue")
  await f.portal().linkControlView(shown.source, shown.viewID, "queue-output")
  f.configure({ remoteID: "native_replacement" })
  expect(await f.portal().receive(raw("withdraw", "/unqueue 1", "queue-output"))).toMatchObject({ result: { kind: "unchanged" } })
  expect(f.controlled).toEqual([{ backendID: "native", control: { action: "withdraw", threadID: "thread_first", nativeID: "native_original" } }])
  const again = await f.show("queue", "queue")
  expect(again.result.items).toEqual([{ inputID: "msg_remote", nativeID: "native_original", text: "", index: 1, observed: false }])
})

test("an unknown numbered mutation is not retried after restart, rebinding or another view publication", async () => {
  const f = fixture(); f.values.set("binding:" + scopeKey(peer), remote)
  const shown = await f.show("queue", "queue")
  await f.portal().linkControlView(shown.source, shown.viewID, "queue-output")
  f.configure({ failControl: true })
  const request = raw("withdraw", "/unqueue 1", "queue-output")
  expect(await f.portal().receive(request)).toMatchObject({ result: { kind: "uncertain" } })
  f.configure({}); f.values.set("binding:" + scopeKey(peer), first)
  expect(await f.portal().receive(request)).toMatchObject({ duplicate: true, result: { kind: "uncertain" } })
  expect(f.controlled).toHaveLength(1)
})

test("publication validates source, current grants and actual outgoing identity rather than trusting arbitrary aliases", async () => {
  const f = fixture(), shown = await f.show("list")
  await expect(f.portal().linkControlView(shown.source, shown.viewID, "list")).rejects.toThrow()
  await expect(f.portal().linkControlView(owner("wrong"), shown.viewID, "wrong-source")).rejects.toThrow()
  await expect(f.portal([]).linkControlView(shown.source, shown.viewID, "no-grant")).rejects.toThrow()
  await f.portal().receive(raw("incoming", "/status"))
  await expect(f.portal().linkControlView(shown.source, shown.viewID, "incoming")).rejects.toThrow("incoming")
  expect(f.gets).not.toContain("ses_second"); expect(f.sent).toEqual([])
})

test("partial publication is unusable until its explicit metadata repair and never revives an earlier rejected command", async () => {
  const f = fixture(), shown = await f.show("list"); f.configure({ failReady: true })
  await expect(f.portal().linkControlView(shown.source, shown.viewID, "list-output")).rejects.toThrow("Interrupted")
  const request = raw("too-early", "/bind 1", "list-output")
  expect(await f.portal().receive(request)).toMatchObject({ result: { kind: "selection-required" } })
  f.configure({})
  await f.portal().linkControlView(shown.source, shown.viewID, "list-output")
  expect(await f.portal().receive(request)).toMatchObject({ result: { kind: "uncertain" } })
  expect(f.gets).toEqual([])
  expect(await f.portal().receive(raw("now", "/bind 1", "list-output"))).toMatchObject({ result: { kind: "bound", target: first } })
})

test("view kinds, out-of-page indices and malformed numbered selectors cannot select a different target", async () => {
  const f = fixture(); f.configure({ incomplete: true })
  const shown = await f.show("list"); await f.portal().linkControlView(shown.source, shown.viewID, "list-output")
  expect(shown.result.incomplete).toBe(true)
  for (const index of ["0", "01", "4", "99999"]) expect(await f.portal().receive(raw("bad-" + index, "/bind " + index, "list-output"))).toMatchObject({ result: { kind: "invalid" } })
  expect(await f.portal().receive(raw("wrong-kind", "/unqueue 1", "list-output"))).toMatchObject({ result: { kind: "conflict" } })
  expect(f.gets).toEqual([]); expect(f.cancelled).toEqual([])
})

test("group members may explicitly select a shared published view but no view crosses group or private scope", async () => {
  const f = fixture(), group: Scope = { ...peer, kind: "group", peerID: "30001" }
  const shown = await f.show("list", "list", group)
  await f.portal().linkControlView(shown.source, shown.viewID, "group-output")
  expect(await f.portal().receive(raw("bind", "/bind 1", "group-output", group, "20002"))).toMatchObject({ result: { kind: "bound", target: first } })
  expect(await f.portal().receive(raw("other", "/bind 1", "group-output", { ...group, peerID: "30002" }))).toMatchObject({ result: { kind: "selection-required" } })
  expect(await f.portal().receive(raw("private", "/bind 1", "group-output"))).toMatchObject({ result: { kind: "selection-required" } })
  expect(f.gets).toEqual(["ses_first"])
})

test("duplicate queue reads after rebind never mix the new conversation text or state into the old view", async () => {
  const f = fixture(), shown = await f.show("queue", "queue")
  f.values.set("binding:" + scopeKey(peer), second)
  f.queues.get("ses_second")!.set("msg_first", "Other conversation body")
  const again = await f.show("queue", "queue")
  expect(again.viewID).toBe(shown.viewID)
  if (again.result.kind !== "queue") throw new Error("Queue expected")
  expect(again.result.target).toEqual(first)
  expect(again.result.items.every((item) => !item.observed && item.text === "")).toBe(true)
  await f.portal().linkControlView(shown.source, shown.viewID, "queue-output")
  expect(await f.portal().receive(raw("wrong-bound", "/unqueue 1", "queue-output"))).toMatchObject({ result: { kind: "conflict" } })
  expect(f.cancelled).toEqual([])
})

test("revoked backend grants and corrupted stored address maps fail closed before any mutation", async () => {
  const f = fixture(), shown = await f.show("list")
  await f.portal().linkControlView(shown.source, shown.viewID, "list-output")
  expect(await f.portal(["20001"], []).receive(raw("revoked", "/bind 3", "list-output"))).toMatchObject({ result: { kind: "forbidden" } })
  const name = [...f.values.keys()].find((key) => key.startsWith("control-view:") && (f.values.get(key) as { id?: string })?.id === shown.viewID)!
  const stored = f.values.get(name)
  f.values.set(name, { ...(stored as Record<string, never>), items: [second, first, remote] })
  expect(await f.portal().receive(raw("corrupt", "/bind 1", "list-output"))).toMatchObject({ result: { kind: "uncertain" } })
  expect(f.gets).toEqual([]); expect(f.controlled).toEqual([])
})

test("selection metadata contains no labels, message bodies, live execution state or mutable latest-view pointer", async () => {
  const f = fixture(), shown = await f.show("list"), queued = await f.show("queue", "queue")
  await f.portal().linkControlView(shown.source, shown.viewID, "list-output")
  await f.portal().linkControlView(queued.source, queued.viewID, "queue-output")
  const text = JSON.stringify([...f.values])
  for (const secret of ["Secret title", "Secret pending body", "Secret remote", "running", "latest"]) expect(text).not.toContain(secret)
  const before = [...f.values.keys()].filter((key) => key.startsWith("control-view:")).length
  await f.portal().receive(raw("status", "/status"))
  expect([...f.values.keys()].filter((key) => key.startsWith("control-view:"))).toHaveLength(before)
  expect(f.values.has("control-view-alias:" + originKey(peer, "list-output"))).toBe(true)
})
