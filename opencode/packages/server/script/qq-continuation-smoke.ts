// Original SDK/HTTP/SQLite/model loop only. No QQ transport, external sends or production profiles.
import assert from "node:assert/strict"
import { mkdtemp, mkdir } from "node:fs/promises"
import path from "node:path"
import { create } from "../../sdk/src/opencode"
import type { StorageDomain } from "../../plugin/src/promise/storage"
import { isConflictError } from "@opencode/client"
import { createPortal } from "../../../../modules/qq-portal/src/index"
import type { Native } from "../../../../modules/qq-portal/src/target"
import { decode, inputID } from "../../../../modules/qq-portal/src/routing"

const root = process.env.IM_QQ_CONTINUATION_TEST_ROOT
if (!root) throw new Error("Use an isolated continuation fixture root")
const home = await mkdtemp(path.join(root, "qq-continuation-")),
  directory = path.join(home, "location")
await mkdir(directory)
const checks: string[] = [],
  requests: unknown[] = []
const entered = Array.from({ length: 5 }, () => Promise.withResolvers<void>())
const release = Array.from({ length: 5 }, () => Promise.withResolvers<void>())
release[3].resolve()
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method !== "POST") return Response.json({ data: [] })
    requests.push(await request.json())
    const serial = requests.length
    entered[serial - 1]?.resolve()
    if (release[serial - 1]) await release[serial - 1].promise
    const chunks = [
      {
        choices: [{ index: 0, delta: { role: "assistant", content: `guarded reply ${serial}` }, finish_reason: null }],
      },
      {
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      },
    ]
    return new Response(
      chunks
        .map(
          (chunk) =>
            `data: ${JSON.stringify({ id: `guarded-${serial}`, object: "chat.completion.chunk", model: "baseline", created: 0, ...chunk })}\n\n`,
        )
        .join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
const config = {
  model: "baseline/baseline",
  update: "disable",
  share: "disabled",
  providers: {
    baseline: {
      name: "Local guarded input fixture",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: `http://127.0.0.1:${upstream.port}/v1`, apiKey: "synthetic" },
      models: {
        baseline: {
          name: "Local model",
          limit: { context: 32000, output: 1024 },
          capabilities: { tools: false, input: ["text"], output: ["text"] },
        },
      },
    },
  },
}
const policy = { botID: "10001", allowedUsers: ["20001"], allowedGroups: [] }
const scope = { botID: "10001", kind: "private" as const, peerID: "20001" }
const message = (id: string, text: string, quote?: string) => ({
  post_type: "message",
  message_type: "private",
  self_id: "10001",
  user_id: "20001",
  message_id: id,
  message: [...(quote ? [{ type: "reply", data: { id: quote } }] : []), { type: "text", data: { text } }],
})
const source = (id: string) => ({ scope, messageID: id, actorID: "20001" })
const nativeID = (raw: unknown) => {
  const event = decode(raw, policy)
  if (event.kind !== "message") throw new Error("Expected a QQ message")
  return inputID(event.message)
}
async function bounded<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout>
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Guarded fixture deadline")), 30_000)
      }),
    ])
  } finally {
    clearTimeout(timer!)
  }
}
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 30_000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Guarded fixture observation deadline")
    await Bun.sleep(20)
  }
}
async function boot() {
  const ready = Promise.withResolvers<StorageDomain>()
  const app = await create({
    database: { path: path.join(home, "application.sqlite") },
    models: { fetch: false },
    runtime: { managedDirectory: directory },
    config: { directory: path.join(home, "config"), project: false, claude: false, content: JSON.stringify(config) },
    fs: { filewatcher: false },
    log: { level: "error", emit: () => {} },
    trustedPlugins: [
      {
        id: "qq-portal",
        setup(context) {
          ready.resolve(context.storage)
        },
      },
    ],
  })
  return { app, storage: ready.promise }
}

let host: Awaited<ReturnType<typeof boot>> | undefined
try {
  host = await boot()
  let app = host.app
  const session = await app.session.create({
    title: "Guarded native input",
    location: { directory },
    model: { providerID: "baseline", id: "baseline" },
  })
  await app.permission.list({ sessionID: session.id })
  let storage = await bounded(host.storage)
  const posts: Parameters<NonNullable<Native["input"]>["continue"]>[0][] = []
  let portal = createPortal({
    policy,
    storage,
    session: {
      ...app.session,
      input: {
        ...app.session.input,
        continue: async (input) => {
          posts.push(input)
          const receipt = await app.session.input.continue(input)
          if (input.text === "lost acknowledgment adjustment")
            throw new Error("Lost native continuation acknowledgment")
          return receipt
        },
      },
    },
  })
  await portal.bind(scope, session.id)
  const first = message("first", "First native task"),
    second = message("second", "Second native task"),
    third = message("third", "Third native task")
  assert.equal((await portal.receive(first)).status, "accepted")
  await bounded(entered[0].promise)
  assert.equal((await portal.receive(second)).status, "accepted")
  await portal.linkReply(source("first"), "first-reply")
  const extra = message("extra", "active input adjustment", "first-reply")
  const lost = message("lost", "lost acknowledgment adjustment", "first-reply")
  assert.deepEqual(await portal.receive(extra), {
    status: "steered",
    target: { kind: "session", sessionID: session.id },
    inputID: nativeID(first),
    continuationID: nativeID(extra),
    delivery: "pending",
    duplicate: false,
  })
  assert.equal((await portal.receive(extra)).status, "steered")
  assert.equal((await portal.receive(lost)).status, "steered")
  assert.equal((await portal.receive(lost)).status, "steered")
  assert.equal(posts.length, 2)
  const read = (raw: unknown, parent = first) =>
    app.session.input.continuation({ sessionID: session.id, inboxID: nativeID(raw), expectedInputID: nativeID(parent) })
  assert.equal((await read(extra)).status, "pending")
  assert.equal((await read(lost)).status, "pending")
  assert.deepEqual(
    (await app.session.inbox.list({ sessionID: session.id })).map((row) => row.id),
    [nativeID(second), nativeID(extra), nativeID(lost)],
  )
  await assert.rejects(
    () => app.session.inbox.update({ sessionID: session.id, inboxID: nativeID(extra), delivery: "queue" }),
    isConflictError,
  )
  checks.push(
    "quoted active input and acknowledged aliases admit native guarded steers once, including a lost acknowledgment, without replacing the queued task",
  )

  release[0].resolve()
  await bounded(entered[1].promise)
  assert.equal((await read(extra)).status, "delivered")
  assert.equal((await read(lost)).status, "delivered")
  const history = await app.session.context({ sessionID: session.id })
  assert.deepEqual(
    history.filter((row) => row.type === "user").map((row) => row.text),
    ["First native task", "active input adjustment", "lost acknowledgment adjustment"],
  )
  assert.deepEqual(
    (await app.session.inbox.list({ sessionID: session.id })).map((row) => row.id),
    [nativeID(second)],
  )
  assert.deepEqual(await portal.sourceFor({ kind: "session", sessionID: session.id }, nativeID(first)), {
    status: "found",
    source: source("first"),
  })
  checks.push(
    "the real runner delivers guarded steers at its next model boundary before the next queued input, preserving the original task source",
  )
  const repeated = {
    sessionID: session.id,
    expectedInputID: nativeID(first),
    inboxID: "msg_repeated_guard",
    text: "CANCELLED REPEATED ADJUSTMENT",
  }
  assert.equal((await app.session.input.continue(repeated)).status, "pending")
  await app.session.inbox.cancel({ sessionID: session.id, inboxID: repeated.inboxID })
  assert.equal((await app.session.input.continuation(repeated)).status, "cancelled")
  checks.push(
    "the original task remains addressable after earlier steers are delivered; cancelling a later steer does not stop or replace that task",
  )

  release[1].resolve()
  await bounded(entered[2].promise)
  assert.deepEqual(await portal.receive(message("late-first", "Must not change the second task", "first-reply")), {
    status: "blocked",
    reason: "quoted-task-not-active",
  })
  const expired = message("expired", "UNCONSUMED EXPIRED ADJUSTMENT", "second")
  assert.equal((await portal.receive(expired)).status, "steered")
  assert.equal((await read(expired, second)).status, "pending")
  assert.equal((await portal.receive(third)).status, "accepted")
  assert.deepEqual(
    await portal.receive({
      post_type: "notice",
      notice_type: "friend_recall",
      self_id: "10001",
      user_id: "20001",
      message_id: "expired",
    }),
    { status: "unchanged" },
  )
  await app.session.interrupt({ sessionID: session.id })
  await until(async () => !(await app.session.active())[session.id])
  release[2].resolve()
  assert.equal((await read(expired, second)).status, "expired")
  assert.deepEqual(
    (await app.session.inbox.list({ sessionID: session.id })).map((row) => row.id),
    [nativeID(third)],
  )
  assert.deepEqual(await portal.receive(expired), { status: "blocked", reason: "quoted-adjustment-expired" })
  assert.equal(posts.filter((input) => input.inboxID === nativeID(expired)).length, 1)
  checks.push(
    "within one busy period an old task quote is rejected; native stop expires an unconsumed adjustment while leaving unrelated queued input intact",
  )

  // Explicit desktop recovery uses the original same-ID prompt wake. QQ redelivery never takes this write path.
  await bounded(
    app.session.prompt({ sessionID: session.id, id: nativeID(third), text: "Third native task", delivery: "queue" }),
  )
  await until(async () => !(await app.session.active())[session.id])
  assert.equal(requests.length, 4)
  assert(!JSON.stringify(requests).includes("UNCONSUMED EXPIRED ADJUSTMENT"))
  assert(!JSON.stringify(requests).includes("CANCELLED REPEATED ADJUSTMENT"))
  assert(!JSON.stringify(requests).includes("Must not change the second task"))
  assert.equal((await app.session.context({ sessionID: session.id })).filter((row) => row.type === "user").length, 5)
  assert.equal((await app.session.input.continue(posts[0])).status, "delivered")
  await assert.rejects(() => app.session.input.continue({ ...posts[0], text: "Changed duplicate" }), isConflictError)
  assert.equal(requests.length, 4)
  checks.push(
    "explicit native resume runs the next task without expired text; duplicate historical POST returns the same handoff without waking the model",
  )

  await app.close()
  host = await boot()
  app = host.app
  await app.permission.list({ sessionID: session.id })
  storage = await bounded(host.storage)
  portal = createPortal({ policy, storage, session: app.session })
  assert.equal((await read(extra)).status, "delivered")
  assert.deepEqual(await portal.receive(extra), {
    status: "steered",
    target: { kind: "session", sessionID: session.id },
    inputID: nativeID(first),
    continuationID: nativeID(extra),
    delivery: "delivered",
    duplicate: true,
  })
  assert.deepEqual(await portal.receive(expired), { status: "blocked", reason: "quoted-adjustment-expired" })
  assert.deepEqual(await portal.sourceFor({ kind: "session", sessionID: session.id }, nativeID(first)), {
    status: "found",
    source: source("first"),
  })
  assert.equal((await app.session.inbox.list({ sessionID: session.id })).length, 0)
  assert.equal(requests.length, 4)
  checks.push(
    "SQLite reopen restores delivered and expired native receipts, source aliases and frozen targets without admission or model replay",
  )
  const restart = message("restart", "Preserved shutdown task"),
    resumeExtra = message("resume-extra", "Pending shutdown adjustment", "restart")
  assert.equal((await portal.receive(restart)).status, "accepted")
  await bounded(entered[4].promise)
  assert.equal((await portal.receive(resumeExtra)).status, "steered")
  assert.equal((await read(resumeExtra, restart)).status, "pending")
  await app.close()
  release[4].resolve()
  host = await boot()
  app = host.app
  await app.permission.list({ sessionID: session.id })
  storage = await bounded(host.storage)
  portal = createPortal({ policy, storage, session: app.session })
  await until(async () => requests.length >= 6 && !(await app.session.active())[session.id])
  assert.equal((await read(resumeExtra, restart)).status, "delivered")
  assert.equal((await portal.receive(resumeExtra)).status, "steered")
  assert.equal(
    (await app.session.context({ sessionID: session.id })).filter((row) => row.id === nativeID(resumeExtra)).length,
    1,
  )
  assert.equal((await app.session.inbox.list({ sessionID: session.id })).length, 0)
  assert.equal(requests.length, 6)
  checks.push(
    "native shutdown preserves pending input ownership; startup recovery consumes its guarded steer once under the original intent",
  )
  console.log(
    JSON.stringify({
      status: "passed",
      checks,
      model_requests: requests.length,
      actual_qq_connection: false,
      external_messages_sent: 0,
      production_credentials_used: false,
    }),
  )
} finally {
  for (const gate of release) gate.resolve()
  await host?.app.close()
  upstream.stop(true)
}
