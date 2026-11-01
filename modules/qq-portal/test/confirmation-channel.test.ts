import { expect, test } from "bun:test"
import { createPortal, createConfirmationChannel, type Source, type NotificationReceipt } from "../src"
import type { Native } from "../src/target"
import type { SendResult } from "../src/onebot"
import { inputID, scopeKey } from "../src/routing"

async function fixture(group = false) {
  const policy = { botID: "10001", allowedUsers: ["20001", "20002"], allowedGroups: ["30001"] }
  const scope = { botID: "10001", kind: group ? "group" as const : "private" as const, peerID: group ? "30001" : "20001" }
  const source = (messageID: string): Source => ({ scope, actorID: "20001", messageID })
  const raw = (id: string, text: string, quote?: string, actor = "20001", mention = true) => ({
    post_type: "message", message_type: scope.kind, self_id: "10001", user_id: actor, message_id: id,
    ...(group ? { group_id: "30001" } : {}),
    message: [...(quote ? [{ type: "reply", data: { id: quote } }] : []), ...(group && mention ? [{ type: "at", data: { qq: "10001" } }] : []), { type: "text", data: { text } }],
  })
  type Value = Parameters<Parameters<typeof createPortal>[0]["storage"]["set"]>[1]
  const values = new Map<string, Value>(), posts: unknown[] = [], delivered = new Set<string>()
  const sends: { source: Source; text: string; messageID: string }[] = [], reads: Source[] = [], notices: NotificationReceipt[] = []
  let missing = false, changed = false, publishFails = false, writeFails: "intent" | "receipt" | undefined
  let sendResult: SendResult | undefined
  const storage = {
    get: async (key: string) => values.get(key), set: async (key: string, value: Value) => { values.set(key, structuredClone(value)) },
    insert: async (key: string, value: Value) => {
      if (publishFails && key.startsWith("confirmation-prompt:") || writeFails === "intent" && key.startsWith("notification:consent:") ||
        writeFails === "receipt" && key.startsWith("notification-receipt:consent:")) throw new Error("Synthetic metadata failure")
      if (values.has(key)) return false
      values.set(key, structuredClone(value)); return true
    },
  }
  const unexpected = async () => { throw new Error("Unexpected new task or cancellation") }
  const session: Native = {
    get: async ({ sessionID }) => ({ id: sessionID } as Awaited<ReturnType<Native["get"]>>), prompt: unexpected,
    message: { get: async () => ({ id: inputID(source("10")), type: "user", text: "parent", time: { created: 1 } }) },
    inbox: { list: async () => [], cancel: unexpected, update: unexpected },
    input: {
      continue: async (request) => { posts.push(request); delivered.add(request.inboxID); return { ...request, rootID: request.expectedInputID, status: "pending" } },
      continuation: async (request) => ({ ...request, ...(delivered.has(request.inboxID) ? { rootID: request.expectedInputID } : {}), status: delivered.has(request.inboxID) ? "pending" : "unknown" }),
    },
  }
  const setup = createPortal({ storage, policy, session: { ...session, prompt: async (request) => ({ id: request.id!, sessionID: request.sessionID, type: "user", delivery: "queue", payload: { text: request.text }, time: { created: 1 } }) } })
  await setup.bind(scope, "ses_original"); await setup.receive(raw("10", "Original task")); await setup.linkReply(source("10"), "-100")
  await setup.bind(scope, "ses_current")
  const original = () => raw("11", changed ? "Changed payload" : "PRIVATE_BODY", "-100")
  const open = () => createConfirmationChannel({
    storage, policy, portal: createPortal({ storage, policy, session }),
    describe: async () => "Original title",
    read: async (value) => { reads.push(value); return missing ? undefined : original() },
    send: async (source, text) => { const messageID = String(-500 - sends.length); sends.push({ source, text, messageID }); return sendResult ?? { status: "sent", messageID } },
    onReceipt: (receipt) => notices.push(receipt),
  })
  return { policy, scope, source, raw, values, storage, posts, sends, reads, notices, open, original,
    configure: (options: { missing?: boolean; changed?: boolean; publishFails?: boolean; writeFails?: typeof writeFails; sendResult?: SendResult }) => {
      missing = options.missing ?? missing; changed = options.changed ?? changed; publishFails = options.publishFails ?? publishFails
      writeFails = options.writeFails; sendResult = options.sendResult
    },
  }
}

test("one acknowledged cross-conversation prompt is quoted to the original request and stores no body or title", async () => {
  const f = await fixture()
  const results = await Promise.all(Array.from({ length: 6 }, () => f.open().receive(f.original())))
  expect(results.every((result) => result.status === "confirmation-required")).toBe(true)
  expect(f.posts).toEqual([]); expect(f.sends).toHaveLength(1)
  expect(f.sends[0]!.source).toEqual(f.source("11"))
  expect(f.sends[0]!.text).toContain("Original title")
  expect(f.sends[0]!.text).toContain("/confirm")
  expect(JSON.stringify([...f.values.values()])).not.toContain("PRIVATE_BODY")
  expect(JSON.stringify([...f.values.values()])).not.toContain("Original title")
})

test("quoted confirmation reads the exact original and delegates once without replacing the current binding", async () => {
  const f = await fixture(); await f.open().receive(f.original())
  const request = f.raw("12", "/CoDeX CoNfIrM", f.sends[0]!.messageID)
  const answer = await f.open().receive(request)
  expect(answer).toMatchObject({ status: "confirmation-control", result: { status: "steered", inputID: inputID(f.source("10")) } })
  expect(f.posts).toHaveLength(1)
  expect(f.posts[0]).toMatchObject({ sessionID: "ses_original", text: "PRIVATE_BODY", inboxID: inputID(f.source("11")) })
  expect(f.reads).toEqual([f.source("11")])
  expect(f.sends[1]!.source).toEqual(f.source("12"))
  expect(f.values.get("binding:" + scopeKey(f.scope))).toEqual({ kind: "session", sessionID: "ses_current" })
  expect((await f.open().receive(request)).status).toBe("confirmation-control")
  expect(f.posts).toHaveLength(1); expect(f.sends).toHaveLength(2)
})

test("decline survives restart and a later opposite choice cannot reactivate the request", async () => {
  const f = await fixture(); await f.open().receive(f.original())
  const prompt = f.sends[0]!.messageID
  expect(await f.open().receive(f.raw("12", "/cancel", prompt))).toMatchObject({ status: "confirmation-control", result: { status: "confirmation-declined" } })
  expect(await f.open().receive(f.raw("13", "/confirm", prompt))).toMatchObject({ status: "confirmation-control", result: { status: "confirmation-already-decided", choice: "decline" } })
  expect(f.posts).toHaveLength(0); expect(f.reads).toHaveLength(1)
})

test("cancel after approval does not undo already admitted work", async () => {
  const f = await fixture(); await f.open().receive(f.original()); const prompt = f.sends[0]!.messageID
  await f.open().receive(f.raw("12", "/confirm", prompt))
  expect(await f.open().receive(f.raw("13", "/cancel", prompt))).toMatchObject({ status: "confirmation-control", result: { status: "confirmation-already-decided", choice: "approve" } })
  expect(f.posts).toHaveLength(1)
  expect(f.sends.at(-1)!.text).toContain("不会撤回")
})

test("group confirmation requires the original actor, group and bot mention before reading any original", async () => {
  const f = await fixture(true); await f.open().receive(f.original()); const prompt = f.sends[0]!.messageID
  expect((await f.open().receive(f.raw("12", "/confirm", prompt, "20001", false))).status).toBe("ignored")
  expect(await f.open().receive(f.raw("13", "/confirm", prompt, "20002"))).toMatchObject({ status: "confirmation-control", result: { status: "confirmation-selection-required" } })
  expect((await f.open().receive({ ...f.raw("14", "/confirm", prompt), group_id: "30002" })).status).toBe("ignored")
  expect((await f.open().receive({ ...f.raw("15", "/confirm", prompt), self_id: "10002" })).status).toBe("ignored")
  expect(f.reads).toHaveLength(0); expect(f.posts).toHaveLength(0)
  expect(await f.open().receive(f.raw("16", "/confirm", prompt))).toMatchObject({ status: "confirmation-control", result: { status: "steered" } })
})

test("unquoted commands and explicit arguments never fall through to the model or select a latest prompt", async () => {
  const f = await fixture(); await f.open().receive(f.original())
  for (const raw of [f.raw("12", "/confirm"), f.raw("13", "/confirm all", f.sends[0]!.messageID), f.raw("14", "/cancel", "-999")])
    expect(await f.open().receive(raw)).toMatchObject({ status: "confirmation-control", result: { status: "confirmation-selection-required" } })
  expect(f.posts).toHaveLength(0); expect(f.reads).toHaveLength(0)
})

test("missing or changed original payloads cannot be approved from saved hashes", async () => {
  for (const changed of [false, true]) {
    const f = await fixture(); await f.open().receive(f.original()); const prompt = f.sends[0]!.messageID
    f.configure({ missing: !changed, changed })
    expect(await f.open().receive(f.raw("12", "/confirm", prompt))).toMatchObject({ status: "confirmation-control", result: { status: changed ? "conflict" : "confirmation-unavailable" } })
    expect(f.posts).toHaveLength(0)
  }
})

test("a recalled original or confirmation command cannot be admitted by its old prompt", async () => {
  const f = await fixture(); await f.open().receive(f.original()); const prompt = f.sends[0]!.messageID
  await f.open().receive({ post_type: "notice", notice_type: "friend_recall", self_id: "10001", user_id: "20001", message_id: "11" })
  expect(await f.open().receive(f.raw("12", "/confirm", prompt))).toMatchObject({ status: "confirmation-control", result: { status: "recalled" } })
  expect(f.posts).toHaveLength(0)
  const command = await fixture(); await command.open().receive(command.original())
  await command.open().receive({ post_type: "notice", notice_type: "friend_recall", self_id: "10001", user_id: "20001", message_id: "12" })
  expect(await command.open().receive(command.raw("12", "/confirm", command.sends[0]!.messageID))).toEqual({ status: "recalled" })
  expect(command.posts).toHaveLength(0); expect(command.reads).toHaveLength(0)
})

test("unknown sends create no selectable confirmation alias and never resend on redelivery", async () => {
  const f = await fixture(); f.configure({ sendResult: { status: "uncertain" } })
  await f.open().receive(f.original()); f.configure({}); await f.open().receive(f.original())
  expect(f.sends).toHaveLength(1)
  expect(await f.open().receive(f.raw("12", "/confirm", "-500"))).toMatchObject({ status: "confirmation-control", result: { status: "confirmation-selection-required" } })
  expect(f.posts).toHaveLength(0)
})

test("acknowledged prompt publication repairs only metadata after a failed alias write", async () => {
  const f = await fixture(); f.configure({ publishFails: true }); await f.open().receive(f.original())
  expect(f.notices.at(-1)).toMatchObject({ status: "sent", linkage: "unlinked" })
  f.configure({ publishFails: false }); await f.open().receive(f.original())
  expect(f.notices.at(-1)).toMatchObject({ status: "sent", linkage: "linked", duplicate: true })
  expect(f.sends).toHaveLength(1)
  expect(await f.open().receive(f.raw("12", "/confirm", "-500"))).toMatchObject({ status: "confirmation-control", result: { status: "steered" } })
  expect(f.posts).toHaveLength(1)
})

test("intent and receipt write failures never authorize another wire effect", async () => {
  for (const writeFails of ["intent", "receipt"] as const) {
    const f = await fixture(); f.configure({ writeFails }); await f.open().receive(f.original())
    expect(f.sends).toHaveLength(writeFails === "intent" ? 0 : 1)
    expect(f.notices.at(-1)!.status).toBe("uncertain")
    // A pre-intent write failure did not send; an existing unknown receipt may never resend.
    if (writeFails === "receipt") { f.configure({}); await f.open().receive(f.original()); expect(f.sends).toHaveLength(1) }
    expect(f.posts).toHaveLength(0)
  }
})

test("a conflicting redelivery cannot change the confirmation command's quoted target", async () => {
  const f = await fixture(); await f.open().receive(f.original()); const prompt = f.sends[0]!.messageID
  await f.open().receive(f.raw("12", "/confirm", prompt))
  expect(await f.open().receive(f.raw("12", "/cancel", prompt))).toEqual({ status: "conflict" })
  expect(f.posts).toHaveLength(1); expect(f.sends).toHaveLength(2)
})

test("a previously refused confirmation cannot become executable when the original later becomes readable", async () => {
  const f = await fixture(); await f.open().receive(f.original()); const prompt = f.sends[0]!.messageID
  const request = f.raw("12", "/confirm", prompt)
  f.configure({ missing: true }); await f.open().receive(request)
  f.configure({ missing: false })
  expect(await f.open().receive(request)).toMatchObject({ status: "confirmation-control", result: { status: "confirmation-previous" } })
  expect(f.posts).toHaveLength(0); expect(f.reads).toHaveLength(1); expect(f.sends).toHaveLength(2)
  expect(await f.open().receive(f.raw("13", "/confirm", prompt))).toMatchObject({ status: "confirmation-control", result: { status: "steered" } })
  expect(f.posts).toHaveLength(1)
})
