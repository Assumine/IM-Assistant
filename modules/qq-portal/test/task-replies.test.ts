import { expect, test } from "bun:test"
import { createTaskReplies, type Source } from "../src"
import type { SendResult } from "../src/onebot"

function fixture() {
  type Options = Parameters<typeof createTaskReplies>[0]
  type Output = Awaited<ReturnType<Options["client"]["experimental"]["session"]["input"]["output"]>>
  type Value = Parameters<Options["storage"]["insert"]>[1]
  const values = new Map<string, Value>(), sends: { source: Source; text: string }[] = [], links: string[] = []
  const policy = { botID: "10001", allowedUsers: ["20001"], allowedGroups: ["30001"] }
  const source: Source = { scope: { botID: "10001", kind: "private", peerID: "20001" }, actorID: "20001", messageID: "10" }
  let output: Output = { sessionID: "ses_first", inputID: "msg_root", rootID: "msg_root", status: "open",
    first: { messageID: "msg_reply", text: "Public first response", settled: true },
    last: { messageID: "msg_reply", text: "Public first response", settled: true } }
  let answer: SendResult = { status: "sent", messageID: "-600" }, permitted = true, publishFails = false, gate: Promise<void> | undefined
  let failure: "intent-before" | "intent-after" | "receipt-before" | undefined
  const client: Options["client"] = {
    event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
    session: { message: { get: async () => { throw new Error("Not used by receipt delivery") } } },
    experimental: { session: { input: { output: async () => structuredClone(output) } } },
  }
  const storage: Options["storage"] = {
    get: async (key) => values.get(key), remove: async (key) => { values.delete(key) },
    scan: async ({ prefix }) => ({ entries: [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) }),
    insert: async (key, value) => {
      if (failure === "intent-before" && key.startsWith("notification:task:") || failure === "receipt-before" && key.startsWith("notification-receipt:task:")) throw new Error("Write failed")
      if (values.has(key)) return false
      values.set(key, structuredClone(value))
      if (failure === "intent-after" && key.startsWith("notification:task:")) throw new Error("Commit acknowledgement lost")
      return true
    },
  }
  const open = () => createTaskReplies({ client, storage, policy,
    sourceFor: async () => permitted ? { status: "found", source } : { status: "forbidden" },
    send: async (source, text) => { sends.push({ source: structuredClone(source), text }); await gate; return answer },
    linkReply: async (_source, id) => { if (publishFails) throw new Error("Publication failed"); links.push(id) },
  })
  return { values, sends, links, policy, source, open, output: () => output,
    update: (value: Partial<Output>) => { output = { ...output, ...value } }, answer: (value: SendResult) => { answer = value },
    permitted: (value: boolean) => { permitted = value }, publication: (value: boolean) => { publishFails = value },
    gate: (value: Promise<void>) => { gate = value }, fail: (value: typeof failure) => { failure = value },
  }
}

test("first and final referring to one native reply share one wire receipt across concurrency and restart", async () => {
  const f = fixture()
  const sent = await Promise.all(Array.from({ length: 6 }, () => f.open().forward("ses_first", "msg_root")))
  expect(sent.some((value) => value.status === "sent")).toBe(true)
  f.update({ status: "closed" })
  expect((await f.open().forward("ses_first", "msg_root")).status).toBe("sent")
  expect(f.sends).toEqual([{ source: f.source, text: "Public first response" }])
  expect(JSON.stringify([...f.values])).not.toContain("Public first response")
})

test("only the first and final public replies are forwarded and each stays quoted to the original source", async () => {
  const f = fixture()
  await f.open().forward("ses_first", "msg_root")
  f.update({ last: { messageID: "msg_middle", text: "Intermediate response", settled: true } })
  await f.open().forward("ses_first", "msg_root")
  expect(f.sends).toHaveLength(1)
  f.update({ status: "closed", last: { messageID: "msg_final", text: "Final response", settled: true } })
  await f.open().forward("ses_first", "msg_root")
  expect(f.sends.map((value) => [value.source.messageID, value.text])).toEqual([["10", "Public first response"], ["10", "Final response"]])
  expect(f.links).toContain("-600")
})

test("a closed input first observed after restart forwards its final result only", async () => {
  const f = fixture()
  f.update({ status: "closed", last: { messageID: "msg_final", text: "Final response", settled: true } })
  await f.open().forward("ses_first", "msg_root")
  expect(f.sends.map((value) => value.text)).toEqual(["Final response"])
})

test("unknown sends and lost intent/receipt writes never authorize another task reply attempt", async () => {
  for (const failure of [undefined, "intent-before", "intent-after", "receipt-before"] as const) {
    const f = fixture()
    f.fail(failure); f.answer({ status: "uncertain" })
    expect((await f.open().forward("ses_first", "msg_root")).status).toBe("uncertain")
    f.fail(undefined)
    await f.open().forward("ses_first", "msg_root")
    f.update({ status: "closed" })
    await f.open().forward("ses_first", "msg_root")
    expect(f.sends.length).toBeLessThanOrEqual(1)
  }
})

test("acknowledged reply publication repairs the original alias without another send", async () => {
  const f = fixture()
  f.publication(true)
  expect(await f.open().forward("ses_first", "msg_root")).toMatchObject({ status: "sent", linkage: "unlinked" })
  f.publication(false)
  expect(await f.open().forward("ses_first", "msg_root")).toMatchObject({ status: "sent", linkage: "linked", duplicate: true })
  expect(f.sends).toHaveLength(1)
  expect(f.links).toEqual(["-600"])
})

test("native identity mismatch, unproven or unsettled output and revoked scope cannot send", async () => {
  const f = fixture()
  f.update({ rootID: "msg_other" })
  expect((await f.open().forward("ses_first", "msg_root")).status).toBe("conflict")
  f.update({ rootID: undefined, status: "unknown" })
  expect((await f.open().forward("ses_first", "msg_root")).status).toBe("ignored")
  f.update({ rootID: "msg_root", status: "open", first: { messageID: "msg_reply", text: "Unsettled", settled: false } })
  expect((await f.open().forward("ses_first", "msg_root")).status).toBe("ignored")
  f.permitted(false)
  expect((await f.open().forward("ses_first", "msg_root")).status).toBe("forbidden")
  expect(f.sends).toHaveLength(0)
  expect(f.values.size).toBe(0)
})

test("group task results stay in their allowed group and overlong replies explicitly link to the client for full text", async () => {
  const f = fixture()
  f.source.scope = { botID: "10001", kind: "group", peerID: "30001" }
  f.update({ first: { messageID: "msg_reply", text: "x".repeat(17000), settled: true } })
  await f.open().forward("ses_first", "msg_root")
  expect(f.sends[0]?.source.scope).toEqual(f.source.scope)
  expect(f.sends[0]?.text.length).toBeLessThan(16000)
  expect(f.sends[0]?.text).toContain("节选")
  f.policy.allowedGroups.length = 0
  expect((await f.open().forward("ses_first", "msg_root")).status).toBe("forbidden")
  expect(f.sends).toHaveLength(1)
})
