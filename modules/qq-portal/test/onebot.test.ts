import { expect, test } from "bun:test"
import type { ServerWebSocket } from "bun"
import { openOneBot, type OneBotOptions, type WireState } from "../src/onebot"
import { event, fakeOneBot, until, type Call } from "./fixture/onebot"

test("authenticated universal socket verifies account and online state before forwarding any event", async () => {
  const fake = fakeOneBot({ early: event(1, "Too early") }), seen: unknown[] = []
  const client = openOneBot({ url: fake.url, token: fake.token, botID: "10001" }, { event: (value) => seen.push(value) })
  try {
    expect((await client.ready).phase).toBe("online")
    expect(fake.calls.map((call) => call.action)).toEqual(["get_login_info", "get_status"])
    expect(fake.upgrades[0]).toEqual({ header: "Bearer " + fake.token, url: fake.url.replace("ws:", "http:") })
    expect(seen).toEqual([])
    fake.event(event(2, "Verified")); await until(() => seen.length === 1)
    expect(seen).toEqual([event(2, "Verified")])
  } finally { client.close(); fake.close() }
})

for (const mode of ["token", "identity", "offline"] as const) test("unverified connection is isolated: " + mode, async () => {
  const fake = fakeOneBot({ ...(mode === "identity" ? { botID: "10002" } : {}), ...(mode === "offline" ? { online: false } : {}) })
  const seen: unknown[] = [], states: WireState[] = []
  const client = openOneBot({ url: fake.url, token: mode === "token" ? "wrong-fixture-token" : fake.token, botID: "10001" }, { event: (value) => seen.push(value), state: (value) => states.push(value) })
  try {
    expect((await client.ready).phase).toBe("unavailable")
    expect(seen).toEqual([])
    expect(JSON.stringify(states)).not.toContain(fake.token)
    if (mode === "token") expect(fake.calls).toEqual([])
  } finally { client.close(); fake.close() }
})

test("heartbeat loss changes state without background status polling or automatic reconnection", async () => {
  const fake = fakeOneBot(), client = openOneBot({ url: fake.url, token: fake.token, botID: "10001" }, { event() {} })
  try {
    await client.ready; fake.event({ post_type: "meta_event", meta_event_type: "heartbeat", self_id: "10001", status: { online: false, good: false } })
    await until(() => client.state().phase === "unavailable")
    await Bun.sleep(30)
    expect(fake.upgrades).toHaveLength(1); expect(fake.calls).toHaveLength(2)
  } finally { client.close(); fake.close() }
})

test("malformed, binary and oversized frames close only their own connection", async () => {
  for (const frame of ["<!DOCTYPE html>", Buffer.from("{}"), "x".repeat(1025)]) {
    const fake = fakeOneBot(), seen: unknown[] = []
    const client = openOneBot({ url: fake.url, token: fake.token, botID: "10001", maxFrameBytes: 1024 }, { event: (value) => seen.push(value) })
    try { await client.ready; fake.frame(frame); await until(() => client.state().phase === "unavailable"); expect(seen).toEqual([]) }
    finally { client.close(); fake.close() }
  }
})

test("outgoing structured replies retain literal text and correlate out-of-order API echoes", async () => {
  const sends: { socket: ServerWebSocket<undefined>; call: Call }[] = []
  const fake = fakeOneBot({ call(socket, call) {
    if (!call.action.startsWith("send_")) return
    sends.push({ socket, call })
    if (sends.length === 2) {
      fake.answer(socket, call, { message_id: -502 })
      const first = sends[0]!.call
      fake.answer(sends[0]!.socket, first, { message_id: -501 })
    }
    return true
  } })
  const client = openOneBot({ url: fake.url, token: fake.token, botID: "10001" }, { event() {} })
  try {
    await client.ready
    const result = await Promise.all([
      client.send({ botID: "10001", kind: "private", peerID: "20001" }, "[CQ:at,qq=all]", "1"),
      client.send({ botID: "10001", kind: "group", peerID: "30001" }, "Group", "2"),
    ])
    expect(result).toEqual([{ status: "sent", messageID: "-501" }, { status: "sent", messageID: "-502" }])
    expect(fake.calls[2]!.params).toEqual({ user_id: 20001, message: [{ type: "reply", data: { id: "1" } }, { type: "text", data: { text: "[CQ:at,qq=all]" } }] })
  } finally { client.close(); fake.close() }
})

test("async, malformed or lost send receipts remain uncertain and are never retried", async () => {
  let sent = 0
  const fake = fakeOneBot({ call(socket, call) {
    if (!call.action.startsWith("send_")) return
    sent++
    if (sent === 1) fake.answer(socket, call, null, "async", 1)
    if (sent === 2) fake.answer(socket, call, {})
    if (sent === 4) fake.answer(socket, call, null, "failed", 1000)
    return true
  } })
  const client = openOneBot({ url: fake.url, token: fake.token, botID: "10001", requestTimeoutMs: 30 }, { event() {} })
  try {
    await client.ready
    const scope = { botID: "10001", kind: "private" as const, peerID: "20001" }
    for (let index = 1; index <= 3; index++) expect(await client.send(scope, "Different explicit notice", String(index))).toEqual({ status: "uncertain" })
    expect(await client.send(scope, "Definitive refusal", "4")).toEqual({ status: "rejected" })
    await Bun.sleep(40); expect(sent).toBe(4)
  } finally { client.close(); fake.close() }
})

test("notification recall uses only the original acknowledged message ID and requires a definitive platform acknowledgment", async () => {
  let deletes = 0
  const fake = fakeOneBot({ call(socket, call) {
    if (call.action !== "delete_msg") return
    deletes++
    expect(call.params).toEqual({ message_id: -500 })
    if (deletes === 1) fake.answer(socket, call, null)
    if (deletes === 2) fake.answer(socket, call, null, "async", 1)
    if (deletes === 3) fake.answer(socket, call, null, "failed", 1000)
    return true
  } })
  const client = openOneBot({ url: fake.url, token: fake.token, botID: "10001", requestTimeoutMs: 30 }, { event() {} })
  const source = { scope: { botID: "10001", kind: "private" as const, peerID: "20001" }, actorID: "20001", messageID: "1" }
  try {
    await client.ready
    expect(await client.recall(source, "-500")).toEqual({ status: "recalled" })
    expect(await client.recall(source, "-500")).toEqual({ status: "uncertain" })
    expect(await client.recall(source, "-500")).toEqual({ status: "rejected" })
    expect(await client.recall(source, "-500")).toEqual({ status: "uncertain" })
    expect(await client.recall({ ...source, scope: { ...source.scope, botID: "10002" } }, "-500")).toEqual({ status: "unavailable" })
    expect(await client.recall(source, "C:/private")).toEqual({ status: "unavailable" })
    expect(deletes).toBe(4)
  } finally { client.close(); fake.close() }
})

test("a malformed API status closes only the wire and settles its send as unknown", async () => {
  const fake = fakeOneBot({ call(socket, call) {
    if (!call.action.startsWith("send_")) return
    socket.send(JSON.stringify({ echo: call.echo, retcode: 0, status: { toString: null }, data: { message_id: -600 } }))
    return true
  } })
  const client = openOneBot({ url: fake.url, token: fake.token, botID: "10001" }, { event() {} })
  try {
    await client.ready
    expect(await client.send({ botID: "10001", kind: "private", peerID: "20001" }, "One explicit notice", "1")).toEqual({ status: "uncertain" })
    expect(client.state()).toEqual({ phase: "unavailable", reason: "protocol" })
    expect(fake.calls.filter((call) => call.action.startsWith("send_"))).toHaveLength(1)
  } finally { client.close(); fake.close() }
})

test("pending request bounds and close settle unknown effects without replay", async () => {
  const fake = fakeOneBot({ call: (_socket, call) => call.action.startsWith("send_") || undefined })
  const client = openOneBot({ url: fake.url, token: fake.token, botID: "10001", maxRequests: 1 }, { event() {} })
  try {
    await client.ready
    const scope = { botID: "10001", kind: "private" as const, peerID: "20001" }
    const first = client.send(scope, "One", "1")
    await until(() => fake.calls.length === 3)
    expect(await client.send(scope, "Not submitted", "2")).toEqual({ status: "unavailable" })
    client.close(); expect(await first).toEqual({ status: "uncertain" })
    expect(client.state().phase).toBe("closed"); expect(fake.calls).toHaveLength(3)
  } finally { client.close(); fake.close() }
})

test("bad configuration fails locally without throwing, opening sockets or exposing credentials", async () => {
  const fake = fakeOneBot()
  try {
    const base = { url: fake.url, token: fake.token, botID: "10001" }
    const changes: Partial<OneBotOptions>[] = [
      { url: fake.url + "?access_token=private-value" }, { token: "" }, { token: "bad\r\nheader" },
      { url: "ws://example.com/" }, { url: fake.url + "api" }, { maxRequests: 0 },
    ]
    for (const change of changes) {
      const client = openOneBot({ ...base, ...change }, { event() {} })
      expect(await client.ready).toEqual({ phase: "unavailable", reason: "configuration" }); client.close()
    }
    const cancelled = openOneBot(base, { event() {} }); cancelled.close()
    expect((await cancelled.ready).phase).toBe("closed")
    expect(fake.upgrades).toEqual([])
  } finally { fake.close() }
})

test("the pinned client refuses redirects instead of forwarding its authorization to another endpoint", async () => {
  const target = fakeOneBot(), redirect = fakeOneBot({ redirect: target.url.replace("ws:", "http:") })
  const client = openOneBot({ url: redirect.url, token: redirect.token, botID: "10001", connectTimeoutMs: 100 }, { event() {} })
  try { expect((await client.ready).phase).toBe("unavailable"); expect(target.upgrades).toEqual([]) }
  finally { client.close(); redirect.close(); target.close() }
})

test("startup verification has a bounded deadline and never forwards buffered events", async () => {
  const fake = fakeOneBot({ early: event(1, "No verification"), call: () => true }), seen: unknown[] = []
  const client = openOneBot({ url: fake.url, token: fake.token, botID: "10001", connectTimeoutMs: 30 }, { event: (value) => seen.push(value) })
  try { expect(await client.ready).toEqual({ phase: "unavailable", reason: "deadline" }); expect(fake.calls).toHaveLength(1); expect(seen).toEqual([]) }
  finally { client.close(); fake.close() }
})

test("exact message reads validate ID, actor and kind without requiring a nonstandard group_id", async () => {
  let group = false
  const fake = fakeOneBot({ call(socket, call) {
    if (call.action !== "get_msg") return
    fake.answer(socket, call, { message_id: call.params.message_id, message_type: group ? "group" : "private",
      sender: { user_id: "20001" }, message: [{ type: "text", data: { text: "Exact original" } }] })
    return true
  } })
  const client = openOneBot({ url: fake.url, token: fake.token, botID: "10001" }, { event() {} })
  try {
    await client.ready
    for (const kind of ["private", "group"] as const) {
      group = kind === "group"
      const source = { scope: { botID: "10001", kind, peerID: group ? "30001" : "20001" }, actorID: "20001", messageID: "10" }
      expect(await client.read(source)).toEqual({ post_type: "message", self_id: "10001", message_type: kind,
        user_id: "20001", message_id: "10", ...(group ? { group_id: "30001" } : {}), message: [{ type: "text", data: { text: "Exact original" } }] })
    }
    expect(fake.calls.filter((call) => call.action === "get_msg").map((call) => call.params)).toEqual([{ message_id: 10 }, { message_id: 10 }])
  } finally { client.close(); fake.close() }
})

test("message reads reject wrong identities and string markup rather than reconstructing content", async () => {
  const changes = [{ message_id: 11 }, { message_type: "private" }, { sender: { user_id: "20002" } },
    { group_id: "30002" }, { message: "[CQ:reply,id=1] Original" }]
  let change = changes[0]
  const fake = fakeOneBot({ call(socket, call) {
    if (call.action !== "get_msg") return
    fake.answer(socket, call, { message_id: 10, message_type: "group", sender: { user_id: "20001" }, message: [], ...change })
    return true
  } })
  const client = openOneBot({ url: fake.url, token: fake.token, botID: "10001" }, { event() {} })
  try {
    await client.ready
    const source = { scope: { botID: "10001", kind: "group" as const, peerID: "30001" }, actorID: "20001", messageID: "10" }
    for (const item of changes) { change = item; expect(await client.read(source)).toBeUndefined() }
    client.close(); expect(await client.read(source)).toBeUndefined()
    expect(fake.calls.filter((call) => call.action === "get_msg")).toHaveLength(changes.length)
  } finally { client.close(); fake.close() }
})

test("explicit history reads use scoped NapCat operations with opaque anchors and no attachment URL expansion", async () => {
  const fake = fakeOneBot({ call(socket, call) {
    if (!call.action.endsWith("msg_history")) return
    fake.answer(socket, call, { messages: [] }); return true
  } })
  const client = openOneBot({ url: fake.url, token: fake.token, botID: "10001" }, { event() {} })
  try {
    await client.ready
    const scope = { botID: "10001", kind: "private" as const, peerID: "20001" }
    expect(await client.history(scope, "-123", 2)).toEqual([])
    expect(await client.history({ ...scope, kind: "group", peerID: "30001" }, undefined, 2)).toEqual([])
    expect(fake.calls[2]).toMatchObject({ action: "get_friend_msg_history", params: { user_id: "20001", message_seq: "-123", count: 2, reverse_order: false, parse_mult_msg: false, disable_get_url: true, quick_reply: false } })
    expect(fake.calls[3]).toMatchObject({ action: "get_group_msg_history", params: { group_id: "30001", count: 2 } })
    expect(await client.history({ ...scope, botID: "10002" }, undefined, 2)).toBeUndefined()
    expect(await client.history(scope, "not-a-message", 2)).toBeUndefined()
    expect(await client.history(scope, undefined, 101)).toBeUndefined()
    expect(fake.calls).toHaveLength(4)
  } finally { client.close(); fake.close() }
})
