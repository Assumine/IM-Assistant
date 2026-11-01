import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { createPortal } from "../src/index"
import { decode, fingerprint, inputID, type Message } from "../src/routing"
import { createImages, createImageReplies, imageConfiguration, maximumImageBytes } from "../src/images"
import type { Native, Backend } from "../src/target"
import { historyEvent, historyStorage } from "./fixture/history"
import { createHistory } from "../src/history"
import { event, policy } from "./fixture/onebot"
import { png, imageName, imagePart } from "./fixture/images"

const raw = (id = 1, text = "Look at this", quote?: string) => ({ ...event(id, text),
  message: [...(quote ? [{ type: "reply", data: { id: quote } }] : []), { type: "text", data: { text } }, imagePart] })
function message(value: unknown = raw()): Message {
  const decoded = decode(value, policy)
  if (decoded.kind !== "message") throw new Error("Expected image message")
  return decoded.message
}
function fixture(images = true) {
  const f = historyStorage(), pending: Awaited<ReturnType<Native["inbox"]["list"]>> = [], sends: Parameters<Native["prompt"]>[0][] = []
  const session: Native = {
    get: async ({ sessionID }) => ({ id: sessionID }) as Awaited<ReturnType<Native["get"]>>,
    prompt: async (request) => { sends.push(request); return { id: request.id, sessionID: request.sessionID, type: "user" } as Awaited<ReturnType<Native["prompt"]>> },
    message: { get: async () => { throw new Error("Not present") } }, inbox: { list: async () => pending, cancel: async () => {}, update: async () => {} },
  }
  let reads = 0
  const reader = createImages({ config: { provider: "napcat", maxBytes: 1024 }, read: async () => { reads++; return { base64: png, file: "C:/do-not-read", url: "https://do-not-fetch.invalid" } } })
  const portal = createPortal({ policy, storage: f.storage, session, ...(images ? { images: reader } : {}) })
  return { ...f, session, pending, sends, portal, reader, reads: () => reads }
}

test("image boundary preserves content and ignores expiring URL metadata, without changing text-only fingerprints", () => {
  const first = message(), second = message({ ...raw(), message: [{ type: "text", data: { text: "Look at this" } }, { ...imagePart, data: { ...imagePart.data, url: "file:///private" } }] })
  expect(fingerprint(first)).toBe(fingerprint(second))
  expect(first.images).toEqual([imageName])
  const plain = message(event(2, "Text only"))
  expect(fingerprint(plain)).toBe(createHash("sha256").update(JSON.stringify([plain.actorID, plain.text, null, plain.mentions])).digest("hex"))
  expect(message(raw(2, "")).text).toBe("")
})

test("unsafe paths, unsupported mixtures, excess pictures and unauthorized messages never become text-only tasks", () => {
  for (const file of ["C:/private.png", "../secret", "file:///x", "https://example.com/x.png", "base64://AAAA", "picture.png"])
    expect(decode({ ...raw(), message: [{ type: "text", data: { text: "Text" } }, { type: "image", data: { file } }] }, policy).kind).toBe("unsupported")
  expect(decode({ ...raw(), message: [imagePart, { type: "file", data: { file: "secret" } }] }, policy).kind).toBe("unsupported")
  expect(decode({ ...raw(), message: Array.from({ length: 5 }, () => imagePart) }, policy).kind).toBe("unsupported")
  expect(decode({ ...raw(), user_id: "99999" }, policy).kind).toBe("ignored")
  expect(decode({ ...raw(), message_type: "group", group_id: "30001" }, policy).kind).toBe("ignored")
})

test("image configuration is explicit, bounded and disabled when absent", () => {
  expect(imageConfiguration(undefined)).toBeUndefined()
  expect(imageConfiguration({ provider: "napcat" })).toEqual({ provider: "napcat", maxBytes: maximumImageBytes })
  for (const value of [{ provider: "onebot" }, { provider: "napcat", maxBytes: 0 }, { provider: "napcat", maxBytes: maximumImageBytes + 1 }, { provider: "napcat", directory: "C:/private" }])
    expect(() => imageConfiguration(value)).toThrow()
})

test("history overlap compares stable image identity rather than expiring image URLs", async () => {
  for (const changed of [false, true]) {
    const f = historyStorage(), base = historyEvent(1, "100"), next = { ...historyEvent(2, "101"), message: raw().message }
    const overlap = { ...next, message: [{ type: "text", data: { text: "Look at this" } }, { type: "image", data: {
      file: changed ? "00000000000000000000000000000000.png" : imageName, url: "C:/expired-cache-location" } }] }
    const history = createHistory({ storage: f.storage, policy, config: { provider: "napcat", pageSize: 2, maxPages: 2 },
      read: async (_, before) => before === undefined ? [next, historyEvent(3, "102")] : [base, overlap] })
    await history.commit(history.entry(base)!)
    if (changed) await expect(history.collect(message().scope)).rejects.toThrow("Conflicting")
    else expect((await history.collect(message().scope)).map((row) => row.messageID)).toEqual(["2", "3"])
  }
})

test("platform bytes are checksum-verified and converted to an inline attachment, never a path", async () => {
  const f = fixture()
  expect(await f.reader(message())).toEqual([{ uri: "data:image/png;base64," + png, source: { type: "inline" }, name: imageName }])
  expect(f.reads()).toBe(1)
})

test("missing, oversized, corrupt and mismatched bytes refuse the complete payload", async () => {
  for (const value of [undefined, { file: "C:/private", url: "https://private.invalid" }, { base64: "<html>" }, { base64: "AAAA" }, { base64: png.slice(4) }, { base64: png + "====" }]) {
    const read = createImages({ config: { provider: "napcat", maxBytes: 1024 }, read: async () => value })
    expect(await read(message())).toBeUndefined()
  }
  const small = createImages({ config: { provider: "napcat", maxBytes: 1 }, read: async () => ({ base64: png }) })
  expect(await small(message())).toBeUndefined()
  const bundle = createImages({ config: { provider: "napcat", maxBytes: Buffer.from(png, "base64").length }, read: async () => ({ base64: png }) })
  expect(await bundle({ ...message(), images: [imageName, imageName] })).toBeUndefined()
})

test("image and text enter one native input once; duplicates reconcile without another image read", async () => {
  const f = fixture(), input = message()
  await f.portal.bind(input.scope, "ses_image")
  expect((await f.portal.receive(raw())).status).toBe("accepted")
  expect(f.sends).toHaveLength(1)
  expect(f.sends[0]).toMatchObject({ id: inputID(input), sessionID: "ses_image", text: "Look at this", delivery: "queue", files: [{ uri: "data:image/png;base64," + png }] })
  // An unknown native receipt is not permission to enqueue or download again.
  expect((await f.portal.receive(raw())).status).toBe("uncertain")
  expect(f.sends).toHaveLength(1)
  expect(f.reads()).toBe(1)
  expect(JSON.stringify([...f.values.values()])).not.toContain(png)
  expect(JSON.stringify([...f.values.values()])).not.toContain("never-fetch")
})

test("disabled image input has a durable refusal and cannot revive after enabling or rebinding", async () => {
  const f = fixture(false), input = message()
  await f.portal.bind(input.scope, "ses_image")
  expect(await f.portal.receive(raw())).toEqual({ status: "blocked", reason: "attachment-disabled" })
  const next = createPortal({ policy, storage: f.storage, session: f.session, images: f.reader })
  await next.bind(input.scope, "ses_other")
  expect(await next.receive(raw())).toEqual({ status: "blocked", reason: "attachment-disabled" })
  expect(f.sends).toEqual([])
  expect(f.reads()).toBe(0)
})

test("image-only messages work, commands with images never execute controls, and early recalls prevent retrieval", async () => {
  const f = fixture(), input = message()
  await f.portal.bind(input.scope, "ses_image")
  expect((await f.portal.receive(raw(2, ""))).status).toBe("accepted")
  expect(f.sends[0]?.text).toBe("")
  expect((await f.portal.receive(raw(3, "/stop"))).status).toBe("unsupported")
  await f.portal.receive({ ...event(4, ""), post_type: "notice", notice_type: "friend_recall" })
  expect((await f.portal.receive(raw(4))).status).toBe("recalled")
  expect(f.reads()).toBe(1)
  expect(f.sends).toHaveLength(1)
})

test("a recall during image retrieval prevents admission after bytes arrive", async () => {
  const f = fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const portal = createPortal({ policy, storage: f.storage, session: f.session, images: async (input) => { entered.resolve(); await release.promise; return f.reader(input) } })
  await portal.bind(message().scope, "ses_image")
  const pending = portal.receive(raw())
  await entered.promise
  await portal.receive({ ...event(1, ""), post_type: "notice", notice_type: "friend_recall" })
  release.resolve()
  expect((await pending).status).toBe("recalled")
  expect(f.sends).toEqual([])
})

test("image retrieval failure is retained; duplicates never fall back to text or repeatedly download", async () => {
  const f = fixture()
  let reads = 0
  const portal = createPortal({ policy, storage: f.storage, session: f.session, images: async () => { reads++; return undefined } })
  await portal.bind(message().scope, "ses_image")
  for (let n = 0; n < 2; n++) expect(await portal.receive(raw())).toEqual({ status: "blocked", reason: "attachment-unavailable" })
  expect(reads).toBe(1)
  expect(f.sends).toEqual([])
})

test("refusal notifications quote the original image once and never resend an unknown result", async () => {
  const f = historyStorage(), sends: string[] = []
  const notify = createImageReplies({ policy, storage: f.storage, send: async (source) => { sends.push(source.messageID); return { status: "uncertain" } } })
  for (let n = 0; n < 2; n++) expect((await notify(message(), { status: "blocked", reason: "attachment-unavailable" })).status).toBe("uncertain")
  expect(sends).toEqual(["1"])
  expect((await notify({ ...message(), actorID: "99999" }, { status: "blocked", reason: "attachment-unavailable" })).status).toBe("forbidden")
})

test("whole backends receive inline bytes only when they advertise support", async () => {
  const f = fixture(), sent: Parameters<Backend["send"]>[0][] = []
  let enabled = false
  const backend: Backend = {
    list: async () => [{ id: "codex-native", label: "Codex", images: enabled }],
    query: async () => ({ thread: { id: "thread" } }),
    execution: async ({ ref }) => ({ thread: { ref, title: "Native", state: "idle" }, queue: [] }),
    control: async () => ({ status: "not-found" }),
    reconcile: async ({ ref, inputID }) => ({ ref, inputID, status: "uncertain" }),
    send: async (input) => { sent.push(input); return { status: "accepted", ref: input.ref, inputID: input.inputID, receipt: { nativeID: "native-image", kind: "queued" } } },
  }
  const portal = createPortal({ policy, storage: f.storage, session: f.session, backend, images: f.reader })
  await portal.bind(message().scope, { kind: "backend", ref: { backendID: "codex-native", threadID: "thread" } })
  expect(await portal.receive(raw())).toEqual({ status: "blocked", reason: "attachment-disabled" })
  enabled = true
  expect((await portal.receive(raw(2))).status).toBe("accepted")
  expect(sent).toHaveLength(1)
  expect(sent[0]?.files?.[0]?.uri).toBe("data:image/png;base64," + png)
  expect(f.sends).toEqual([])
})
