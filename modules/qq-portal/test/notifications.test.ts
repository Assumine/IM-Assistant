import { expect, test } from "bun:test"
import { claimIngress } from "../src/controls"
import { createControlReplies, controlReply, type ControlResponse, type Message, type Source } from "../src"
import type { SendResult } from "../src/onebot"
import { inputID, originKey } from "../src/routing"

function fixture() {
  const policy = { botID: "10001", allowedUsers: ["20001", "20002"], allowedGroups: ["30001"] }
  const permissions = { allowedUsers: ["20001"], backendIDs: ["native"] }
  type Value = Parameters<Parameters<typeof createControlReplies>[0]["storage"]["insert"]>[1]
  const values = new Map<string, Value>(), sends: { source: Source; text: string }[] = [], publications: { source: Source; viewID: string; id: string }[] = []
  let failure: "intent-before" | "intent-after" | "receipt-before" | "receipt-after" | "read" | "receipt-read" | undefined, publicationFails = false
  let answer: SendResult | "throw" = { status: "sent", messageID: "-500" }, gate: Promise<void> | undefined
  const storage = {
    get: async (key: string) => { if (failure === "read" || failure === "receipt-read" && sends.length > 0 && key.startsWith("notification-receipt:")) throw new Error("Storage unavailable"); return values.get(key) },
    set: async (key: string, value: Value) => { values.set(key, structuredClone(value)) },
    insert: async (key: string, value: Value) => {
      const kind = key.startsWith("notification:control:") ? "intent" : key.startsWith("notification-receipt:") ? "receipt" : undefined
      if (kind && failure === kind + "-before") throw new Error("Write failed before commit")
      if (values.has(key)) return false
      values.set(key, structuredClone(value))
      if (kind && failure === kind + "-after") throw new Error("Write acknowledgement lost")
      return true
    },
  }
  const open = () => createControlReplies({ storage, policy, permissions,
    send: async (source, text) => { sends.push({ source, text }); await gate; if (answer === "throw") throw new Error("Unknown network result"); return answer },
    publish: async (source, viewID, id) => { if (publicationFails) throw new Error("View publication failed"); publications.push({ source, viewID, id }) },
  })
  const message = (id = "10", text = "/list"): Message => ({ scope: { botID: "10001", kind: "private", peerID: "20001" }, actorID: "20001", messageID: id, text, mentions: [] })
  const response = (input: Message): ControlResponse => ({ status: "control", commandID: inputID(input), action: "list", duplicate: false,
    result: { kind: "conversations", viewID: "view_qq_" + originKey(input.scope, input.messageID) + "_" + "a".repeat(64),
      items: [{ target: { kind: "session", sessionID: "ses_first" }, title: "PRIVATE_TITLE", index: 1, observed: true }], incomplete: false, unavailable: [] } })
  const source = (input: Message): Source => ({ scope: input.scope, actorID: input.actorID, messageID: input.messageID })
  return { policy, permissions, values, sends, publications, storage, open, message, response, source,
    prepare: (input: Message) => claimIngress(storage, input, true),
    fail: (value: typeof failure) => { failure = value }, publishFails: (value: boolean) => { publicationFails = value },
    answer: (value: typeof answer) => { answer = value }, gate: (value?: Promise<void>) => { gate = value },
  }
}

test("a durable notification intent precedes its one wire attempt and only an acknowledged ID publishes a view", async () => {
  const f = fixture(), input = f.message(), response = f.response(input)
  await f.prepare(input)
  const replies = f.open(), result = await replies.deliver(input, response)
  expect(result).toEqual({ status: "sent", messageID: "-500", linkage: "linked", duplicate: false })
  expect(f.publications).toEqual([{ source: f.source(input), viewID: response.result.kind === "conversations" ? response.result.viewID : "", id: "-500" }])
  expect(f.sends).toHaveLength(1)
  expect(f.sends[0]!.source).toEqual(f.source(input))
  expect(f.sends[0]!.text).toContain("1. PRIVATE_TITLE")
  expect(JSON.stringify([...f.values])).not.toContain("PRIVATE_TITLE")
  expect(JSON.stringify([...f.values])).not.toContain("/list")
})

test("concurrent duplicate callbacks cannot send again while the first receipt is in flight", async () => {
  const f = fixture(), input = f.message(), response = f.response(input), release = Promise.withResolvers<void>()
  await f.prepare(input); f.gate(release.promise)
  const first = f.open().deliver(input, response)
  while (!f.sends.length) await Bun.sleep(1)
  expect(await f.open().deliver(input, response)).toEqual({ status: "uncertain", duplicate: true })
  release.resolve(); expect((await first).status).toBe("sent")
  expect((await f.open().deliver(input, response)).status).toBe("sent")
  expect(f.sends).toHaveLength(1)
})

test("restart and fresh read labels preserve the first acknowledged notification and original view mapping", async () => {
  const f = fixture(), input = f.message(), response = f.response(input)
  await f.prepare(input); await f.open().deliver(input, response)
  const changed = structuredClone(response)
  if (changed.result.kind !== "conversations") throw new Error("Fixture view missing")
  changed.result.viewID = "view_qq_" + "b".repeat(64) + "_" + "c".repeat(64)
  changed.result.items.reverse(); changed.result.items[0]!.title = "CHANGED_LABEL"
  expect(await f.open().deliver(input, changed)).toMatchObject({ status: "sent", messageID: "-500", duplicate: true })
  expect(f.publications.at(-1)!.viewID).toBe(f.publications[0]!.viewID)
  expect(f.sends).toHaveLength(1)
  expect(f.sends[0]!.text).not.toContain("CHANGED_LABEL")
})

for (const failure of ["intent-before", "intent-after"] as const) test("intent storage failure cannot reach the wire: " + failure, async () => {
  const f = fixture(), input = f.message(); await f.prepare(input); f.fail(failure)
  expect((await f.open().deliver(input, f.response(input))).status).toBe("uncertain")
  expect(f.sends).toHaveLength(0)
  if (failure === "intent-after") {
    f.fail(undefined)
    expect((await f.open().deliver(input, f.response(input))).status).toBe("uncertain")
    expect(f.sends).toHaveLength(0)
  }
})

test("a lost receipt database write never resends the message or publishes an unconfirmed view", async () => {
  const f = fixture(), input = f.message(); await f.prepare(input); f.fail("receipt-before")
  expect((await f.open().deliver(input, f.response(input))).status).toBe("uncertain")
  f.fail(undefined)
  expect((await f.open().inspect(f.source(input))).status).toBe("uncertain")
  expect((await f.open().deliver(input, f.response(input))).status).toBe("uncertain")
  expect(f.sends).toHaveLength(1); expect(f.publications).toHaveLength(0)
})

test("a committed receipt with a lost database acknowledgement is reconciled by reading, without another send", async () => {
  const f = fixture(), input = f.message(); await f.prepare(input); f.fail("receipt-after")
  expect(await f.open().deliver(input, f.response(input))).toMatchObject({ status: "sent", linkage: "linked" })
  expect(f.sends).toHaveLength(1)
})

for (const answer of ["throw", { status: "uncertain" }, { status: "unavailable" }, { status: "rejected" }] as const) test("unknown or unsuccessful output remains a notification fact with no automatic replay: " + (typeof answer === "string" ? answer : answer.status), async () => {
  const f = fixture(), input = f.message(); await f.prepare(input); f.answer(answer)
  const expected = typeof answer === "string" ? "uncertain" : answer.status
  expect((await f.open().deliver(input, f.response(input))).status).toBe(expected)
  f.answer({ status: "sent", messageID: "-900" })
  expect((await f.open().deliver(input, f.response(input))).status).toBe(expected)
  expect(f.sends).toHaveLength(1); expect(f.publications).toHaveLength(0)
})

test("view publication can repair metadata after an acknowledged send without delivering again", async () => {
  const f = fixture(), input = f.message(); await f.prepare(input); f.publishFails(true)
  expect(await f.open().deliver(input, f.response(input))).toMatchObject({ status: "sent", linkage: "unlinked" })
  f.publishFails(false)
  expect(await f.open().deliver(input, f.response(input))).toMatchObject({ status: "sent", linkage: "linked", duplicate: true })
  expect(f.sends).toHaveLength(1); expect(f.publications).toHaveLength(1)
})

test("inspection is read-only, including when storage is unavailable or a previously allowed recipient is revoked", async () => {
  const f = fixture(), input = f.message(), replies = f.open(); await f.prepare(input)
  expect(await replies.inspect(f.source(input))).toEqual({ status: "missing" })
  await replies.deliver(input, f.response(input)); const publications = f.publications.length
  expect(await replies.inspect(f.source(input))).toMatchObject({ status: "sent", linkage: "not-checked" })
  f.fail("read"); expect((await replies.inspect(f.source(input))).status).toBe("uncertain"); f.fail(undefined)
  f.policy.allowedUsers.splice(0, 1)
  expect((await replies.inspect(f.source(input))).status).toBe("forbidden")
  expect(f.sends).toHaveLength(1); expect(f.publications).toHaveLength(publications)
})

test("wrong command identity, conflicting body and foreign scope cannot create a notification attempt", async () => {
  const f = fixture(), input = f.message(); await f.prepare(input)
  const variants: [Message, ControlResponse][] = [
    [input, { ...f.response(input), commandID: "msg_wrong" }], [input, { ...f.response(input), action: "queue" }],
    [{ ...input, text: "/queue" }, { ...f.response(input), action: "queue" }],
    [{ ...input, scope: { ...input.scope, botID: "10002" } }, f.response(input)],
    [{ ...input, scope: { botID: "10001", kind: "group", peerID: "30002" } }, f.response(input)],
  ]
  for (const [message, response] of variants) expect(["conflict", "forbidden"]).toContain((await f.open().deliver(message, response)).status)
  expect(f.sends).toHaveLength(0)
})

test("task authorization alone cannot generate privileged control content or publish a view", async () => {
  const f = fixture(), input = { ...f.message(), actorID: "20002", scope: { botID: "10001", kind: "private" as const, peerID: "20002" } }
  await f.prepare(input)
  expect((await f.open().deliver(input, f.response(input))).status).toBe("forbidden")
  expect((await f.open().deliver(input, { ...f.response(input), result: { kind: "forbidden" } })).status).toBe("sent")
  expect(f.sends[0]!.text).toBe("该命令未获授权。"); expect(f.publications).toHaveLength(0)
})

test("oversized catalogs refuse visual selectors instead of publishing a mapping whose rows were hidden", async () => {
  const f = fixture(), input = f.message(), response = f.response(input); await f.prepare(input)
  if (response.result.kind !== "conversations") throw new Error("Fixture view missing")
  response.result.items = Array.from({ length: 200 }, (_, index) => ({ index: index + 1, target: { kind: "session", sessionID: "ses_" + index }, title: "x".repeat(140), observed: true }))
  expect((await f.open().deliver(input, response)).status).toBe("sent")
  expect(f.sends[0]!.text).toContain("未开放序号选择"); expect(f.publications).toHaveLength(0)
})

test("corrupted intent or acknowledgement metadata stays uncertain and cannot trigger sending or alias repair", async () => {
  for (const corrupted of ["intent", "receipt"] as const) {
    const f = fixture(), input = f.message(); await f.prepare(input); await f.open().deliver(input, f.response(input))
    const key = (corrupted === "intent" ? "notification:control:" : "notification-receipt:control:") + originKey(input.scope, input.messageID)
    const old = f.values.get(key)
    if (!old || typeof old !== "object" || Array.isArray(old)) throw new Error("Fixture metadata missing")
    f.values.set(key, { ...old, hash: "0".repeat(64) })
    expect((await f.open().deliver(input, f.response(input))).status).toBe("uncertain")
    expect(f.sends).toHaveLength(1); expect(f.publications).toHaveLength(1)
  }
})

test("control presentation preserves partial/unknown facts, stable indices and historical write semantics", () => {
  const response: ControlResponse = { status: "control", commandID: "msg_x", action: "queue", duplicate: false,
    result: { kind: "queue", target: { kind: "session", sessionID: "ses_x" }, items: [{ inputID: "msg_x", nativeID: "msg_x", text: "", index: 7, observed: false }], incomplete: true } }
  const text = controlReply(response).text
  expect(text).toContain("7. 本次未观察到"); expect(text).toContain("当前执行状态尚未确认"); expect(text).toContain("并非完整队列")
  const withdrawn = controlReply({ ...response, duplicate: true, result: { kind: "withdraw-requested", target: { kind: "session", sessionID: "ses_x" }, inputID: "msg_old" } }).text
  expect(withdrawn).toContain("原命令已发出撤回请求"); expect(withdrawn).not.toContain("已撤回")
})

test("same message IDs in private and group scopes keep separate receipts and never substitute the recipient", async () => {
  const f = fixture(), input = f.message(), group: Message = { ...input, scope: { botID: "10001", kind: "group", peerID: "30001" }, mentions: ["10001"] }
  await f.prepare(input); await f.prepare(group)
  await f.open().deliver(input, f.response(input)); await f.open().deliver(group, f.response(group))
  expect(f.sends.map((row) => row.source.scope.kind)).toEqual(["private", "group"])
  await f.open().deliver(input, f.response(input)); await f.open().deliver(group, f.response(group))
  expect(f.sends).toHaveLength(2)
  const forged = { ...group, mentions: [] }
  expect((await f.open().deliver(forged, f.response(forged))).status).toBe("ignored")
})

test("an invalid acknowledged message ID is never published or retried", async () => {
  const f = fixture(), input = f.message(); await f.prepare(input)
  f.answer({ status: "sent", messageID: "not-an-actual-wire-ID" })
  expect((await f.open().deliver(input, f.response(input))).status).toBe("uncertain")
  expect((await f.open().deliver(input, f.response(input))).status).toBe("uncertain")
  expect(f.sends).toHaveLength(1); expect(f.publications).toHaveLength(0)
})

test("revoked backend grants cannot produce new outbound control content", async () => {
  const f = fixture(), input = f.message(), response = f.response(input); await f.prepare(input)
  response.result = { kind: "bound", target: { kind: "backend", ref: { backendID: "not-authorized", threadID: "thread_1" } } }
  expect((await f.open().deliver(input, response)).status).toBe("forbidden")
  expect(f.sends).toHaveLength(0)
})

test("a receipt read failure after sending stays uncertain and later reconciliation reads the committed acknowledgment", async () => {
  const f = fixture(), input = f.message(); await f.prepare(input); f.fail("receipt-read")
  expect((await f.open().deliver(input, f.response(input))).status).toBe("uncertain")
  f.fail(undefined)
  expect((await f.open().inspect(f.source(input))).status).toBe("sent")
  expect((await f.open().deliver(input, f.response(input))).status).toBe("sent")
  expect(f.sends).toHaveLength(1)
})

test("an orphaned receipt without its intent is uncertain and cannot authorize a fresh notification", async () => {
  const f = fixture(), input = f.message(); await f.prepare(input)
  f.values.set("notification-receipt:control:" + originKey(input.scope, input.messageID), { version: 1, hash: "0".repeat(64), status: "sent", messageID: "-500" })
  expect((await f.open().inspect(f.source(input))).status).toBe("uncertain")
  expect((await f.open().deliver(input, f.response(input))).status).toBe("uncertain")
  expect(f.sends).toHaveLength(0); expect(f.publications).toHaveLength(0)
})
