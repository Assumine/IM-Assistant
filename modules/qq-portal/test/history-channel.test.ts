import { expect, test } from "bun:test"
import type { ServerWebSocket } from "bun"
import { createPortal, openQQChannel, type Result, type ChannelIssue } from "../src"
import type { Native } from "../src/target"
import { inputID } from "../src/routing"
import { fakeOneBot, policy, until, type Call } from "./fixture/onebot"
import { historyEvent, historyStorage } from "./fixture/history"

async function fixture(extraUsers: string[] = []) {
  const permissions = { ...policy, allowedUsers: [...policy.allowedUsers, ...extraUsers] }
  const f = historyStorage(), pending = new Map<string, Awaited<ReturnType<Native["inbox"]["list"]>>[number]>()
  const posts: Parameters<Native["prompt"]>[0][] = [], results: { id: string; result: Result }[] = [], issues: ChannelIssue[] = []
  const rows = new Map<string, ReturnType<typeof historyEvent>[]>(), held: { socket: ServerWebSocket<undefined>; call: Call }[] = []
  let holdPeer: string | undefined, failCallback = false, omitBoundary = false
  const answer = (socket: ServerWebSocket<undefined>, call: Call) => {
    if (!fake.sockets.has(socket)) return
    const peer = String(call.params.user_id ?? call.params.group_id), all = rows.get(peer) ?? []
    const index = call.params.message_seq === undefined ? all.length - 1 : all.findIndex((row) => String(row.message_id) === call.params.message_seq)
    const page = index < 0 ? [] : all.slice(Math.max(omitBoundary ? 1 : 0, index - Number(call.params.count) + 1), index + 1)
    fake.answer(socket, call, { messages: page })
  }
  const fake = fakeOneBot({ call(socket, call) {
    if (call.action !== "get_friend_msg_history" && call.action !== "get_group_msg_history") return
    if (holdPeer === "*" || String(call.params.user_id ?? call.params.group_id) === holdPeer) held.push({ socket, call })
    else answer(socket, call)
    return true
  } })
  const unexpected = async () => { throw new Error("Unexpected native operation") }
  const session: Native = {
    get: async ({ sessionID }) => ({ id: sessionID } as Awaited<ReturnType<Native["get"]>>),
    prompt: async (input) => {
      posts.push(input)
      const item = { sessionID: input.sessionID, id: input.id!, type: "user" as const, delivery: "queue" as const, payload: { text: input.text }, time: { created: 1 } }
      pending.set(input.id!, item); return item
    },
    message: { get: unexpected },
    inbox: { list: async ({ sessionID }) => [...pending.values()].filter((row) => row.sessionID === sessionID),
      cancel: async ({ inboxID }) => { pending.delete(inboxID) }, update: unexpected },
  }
  const portal = createPortal({ storage: f.storage, policy: permissions, session })
  const scope = { botID: "10001", kind: "private" as const, peerID: "20001" }
  await portal.bind(scope, "ses_original")
  await portal.bind({ ...scope, peerID: "20002" }, "ses_other")
  for (const peerID of extraUsers) await portal.bind({ ...scope, peerID }, "ses_" + peerID)
  const open = () => openQQChannel({ policy: permissions, portal, connection: { url: fake.url, token: fake.token },
    history: { config: { provider: "napcat", pageSize: 2, maxPages: 4 }, storage: f.storage },
    onIssue: (value) => issues.push(value),
    onResult: ({ source, result }) => { if (failCallback) throw new Error("Subscription metadata unavailable"); results.push({ id: source.messageID, result }) },
  })
  const emit = (row: ReturnType<typeof historyEvent>) => { const list = rows.get(row.user_id) ?? []; if (!list.some((value) => value.message_id === row.message_id)) list.push(row); rows.set(row.user_id, list); fake.event(row) }
  return { ...f, portal, scope, posts, results, issues, pending, rows, held, fake, open, emit,
    release: () => { holdPeer = undefined; for (const value of held.splice(0)) answer(value.socket, value.call) },
    hold: (peer: string) => { holdPeer = peer },
    callbackFails: (value: boolean) => { failCallback = value },
    omitBoundary: (value: boolean) => { omitBoundary = value },
  }
}

test("first use starts at observed live input; restart recovers ordered pages before new live traffic without a second native queue", async () => {
  const f = await fixture(); let channel = f.open()
  try {
    await channel.ready
    f.emit(historyEvent(-20, "100", "First task")); await until(() => f.values.has("history:cursor:10001:private:20001"))
    expect(f.fake.calls.filter((call) => call.action.includes("msg_history"))).toHaveLength(0)
    await channel.close()
    f.rows.get("20001")!.push(historyEvent(9, "101", "Offline one"), historyEvent(-5, "102", "Offline two"))
    f.hold("20001"); channel = f.open(); await channel.ready; await until(() => f.held.length === 1)
    f.emit(historyEvent(1, "103", "New live input")); f.release()
    await until(() => f.posts.length === 4 && channel.state().pendingEvents === 0)
    expect(f.posts.map((value) => value.id)).toEqual([-20, 9, -5, 1].map((id) => inputID({ scope: f.scope, messageID: String(id) })))
    expect(f.posts[1]!.text).toContain("补收的历史留言")
    expect(f.posts[1]!.text).toEndWith("\nOffline one")
    expect(f.posts[3]!.text).toBe("New live input")
    expect(channel.state().recoveredMessages).toBe(2)
    expect(f.values.get("history:cursor:10001:private:20001")).toMatchObject({ messageID: "1", sequence: "103" })
    f.emit(historyEvent(9, "101", "Offline one"))
    await until(() => f.results.filter((value) => value.id === "9").length === 2 && channel.state().pendingEvents === 0)
    expect(f.posts).toHaveLength(4)
    expect(JSON.stringify([...f.values.values()])).not.toContain("Offline one")
    expect(f.pending.size).toBe(4)
  } finally { f.release(); await channel.close(); f.fake.close() }
})

test("a slow recovering peer cannot block another peer's history or live admission", async () => {
  const f = await fixture(); let channel = f.open()
  try {
    await channel.ready
    f.emit(historyEvent(1, "100")); f.emit(historyEvent(10, "200", "Other baseline", "20002"))
    await until(() => f.values.size > 5 && channel.state().pendingEvents === 0)
    await channel.close()
    f.rows.get("20001")!.push(historyEvent(2, "101"))
    f.rows.get("20002")!.push(historyEvent(11, "201", "Other offline", "20002"))
    f.hold("20001"); channel = f.open(); await channel.ready
    await until(() => f.held.length === 1 && f.posts.some((value) => value.text.endsWith("Other offline")))
    f.emit(historyEvent(12, "202", "Other live", "20002"))
    await until(() => f.posts.some((value) => value.text === "Other live"))
    expect(f.posts.some((value) => value.text.endsWith("Body 2"))).toBe(false)
    f.release(); await until(() => channel.state().recoveringScopes === 0)
    expect(f.posts.some((value) => value.text.endsWith("Body 2"))).toBe(true)
  } finally { f.release(); await channel.close(); f.fake.close() }
})

test("a recall received during history fetch is applied through the original portal before its recovered task", async () => {
  const f = await fixture(); let channel = f.open()
  try {
    await channel.ready; f.emit(historyEvent(1, "100")); await until(() => channel.state().pendingEvents === 0 && f.posts.length === 1)
    await channel.close()
    f.rows.get("20001")!.push(historyEvent(2, "101"), historyEvent(3, "102"))
    f.hold("20001"); channel = f.open(); await channel.ready; await until(() => f.held.length === 1)
    f.fake.event({ post_type: "notice", notice_type: "friend_recall", self_id: "10001", user_id: "20001", message_id: 2 })
    await until(() => channel.state().pendingEvents === 1)
    f.release(); await until(() => channel.state().recoveringScopes === 0 && channel.state().pendingEvents === 0)
    expect(f.posts.map((value) => value.id)).toEqual([1, 3].map((id) => inputID({ scope: f.scope, messageID: String(id) })))
    expect(f.pending.has(inputID({ scope: f.scope, messageID: "1" }))).toBe(true)
    expect(f.results.filter((value) => value.id === "2" && value.result.status === "unchanged")).toHaveLength(1)
  } finally { f.release(); await channel.close(); f.fake.close() }
})

test("a missing history boundary admits none of the partial page and reports only that peer unavailable", async () => {
  const f = await fixture(); let channel = f.open()
  try {
    await channel.ready; f.emit(historyEvent(1, "100")); await until(() => channel.state().pendingEvents === 0 && f.posts.length === 1)
    await channel.close()
    f.rows.get("20001")!.push(historyEvent(2, "101"), historyEvent(3, "102")); f.omitBoundary(true)
    channel = f.open(); await channel.ready; await until(() => channel.state().blockedScopes === 1)
    expect(f.posts).toHaveLength(1)
    expect(f.issues.some((value) => value.kind === "history-unavailable")).toBe(true)
    expect(f.values.get("history:cursor:10001:private:20001")).toMatchObject({ sequence: "100" })
    f.emit(historyEvent(10, "200", "Unaffected live input", "20002"))
    await until(() => f.posts.length === 2)
    expect(f.posts[1]!.text).toBe("Unaffected live input")
  } finally { f.release(); await channel.close(); f.fake.close() }
})

test("a failed admission callback leaves the checkpoint behind and restart reconciles the original input without submitting twice", async () => {
  const f = await fixture(); let channel = f.open()
  try {
    await channel.ready; f.emit(historyEvent(1, "100")); await until(() => channel.state().pendingEvents === 0 && f.posts.length === 1)
    await channel.close()
    f.rows.get("20001")!.push(historyEvent(2, "101"), historyEvent(3, "102")); f.callbackFails(true)
    channel = f.open(); await channel.ready; await until(() => channel.state().blockedScopes === 1)
    expect(f.posts).toHaveLength(2)
    expect(f.values.get("history:cursor:10001:private:20001")).toMatchObject({ sequence: "100" })
    await channel.close(); f.callbackFails(false)
    channel = f.open(); await channel.ready; await until(() => channel.state().recoveringScopes === 0 && f.posts.length === 3)
    expect(f.posts.filter((value) => value.id === inputID({ scope: f.scope, messageID: "2" }))).toHaveLength(1)
    expect(f.results.some((value) => value.id === "2" && value.result.status === "accepted" && value.result.duplicate)).toBe(true)
    expect(f.values.get("history:cursor:10001:private:20001")).toMatchObject({ sequence: "102" })
  } finally { f.release(); await channel.close(); f.fake.close() }
})

test("closing during a history read settles its bounded request and does not admit buffered live work", async () => {
  const f = await fixture(); let channel = f.open()
  try {
    await channel.ready; f.emit(historyEvent(1, "100")); await until(() => channel.state().pendingEvents === 0 && f.posts.length === 1)
    await channel.close(); f.rows.get("20001")!.push(historyEvent(2, "101"))
    f.hold("20001"); channel = f.open(); await channel.ready; await until(() => f.held.length === 1)
    f.emit(historyEvent(3, "102")); await until(() => channel.state().pendingEvents === 1)
    await channel.close()
    expect(f.posts).toHaveLength(1)
    expect(f.pending.size).toBe(1)
    expect(f.values.get("history:cursor:10001:private:20001")).toMatchObject({ sequence: "100" })
  } finally { f.release(); await channel.close(); f.fake.close() }
})

test("an out-of-sequence first live delivery remains a task while an old unbound message cannot revive after binding", async () => {
  const f = await fixture(); const channel = f.open()
  try {
    await channel.ready; f.emit(historyEvent(1, "100")); await until(() => channel.state().pendingEvents === 0 && f.posts.length === 1)
    f.emit(historyEvent(3, "102")); f.emit(historyEvent(2, "101"))
    await until(() => channel.state().pendingEvents === 0 && f.posts.length === 3)
    expect(f.posts.map((value) => value.text)).toEqual(["Body 1", "Body 3", "Body 2"])
    expect(f.values.get("history:cursor:10001:private:20001")).toMatchObject({ sequence: "101" })
    await f.portal.bind(f.scope)
    const unbound = historyEvent(4, "105", "Previously unbound")
    f.emit(unbound); await until(() => f.results.some((value) => value.id === "4" && value.result.status === "unbound"))
    await f.portal.bind(f.scope, "ses_original")
    f.emit(unbound); f.emit(historyEvent(5, "106", "After duplicate sentinel"))
    await until(() => f.results.some((value) => value.id === "5"))
    expect(f.posts).toHaveLength(4)
    expect(f.posts.some((value) => value.text === "Previously unbound")).toBe(false)
  } finally { f.release(); await channel.close(); f.fake.close() }
})

test("many recovering peers share a bounded read budget instead of exhausting the wire's request slots", async () => {
  const peers = ["20001", "20002", "20003", "20004", "20005", "20006"]
  const f = await fixture(peers.slice(2)); let channel = f.open()
  try {
    await channel.ready
    for (const [index, peer] of peers.entries()) f.emit(historyEvent(index + 1, "100", "Baseline", peer))
    await until(() => f.posts.length === peers.length && channel.state().pendingEvents === 0)
    await channel.close(); f.hold("*")
    channel = f.open(); await channel.ready
    await until(() => f.held.length === 4)
    expect(f.fake.calls.filter((call) => call.action.endsWith("msg_history"))).toHaveLength(4)
    f.release(); await until(() => channel.state().recoveringScopes === 0)
    expect(f.fake.calls.filter((call) => call.action.endsWith("msg_history"))).toHaveLength(6)
    expect(channel.state().blockedScopes).toBe(0)
    expect(f.posts).toHaveLength(6)
  } finally { f.release(); await channel.close(); f.fake.close() }
})
