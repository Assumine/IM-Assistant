// Real SDK/SQLite plus authenticated loopback OneBot fixture. No real QQ account, login or external message.
import assert from "node:assert/strict"
import { mkdtemp, mkdir } from "node:fs/promises"
import path from "node:path"
import { create } from "../../sdk/src/opencode"
import type { StorageDomain } from "../../plugin/src/promise/storage"
import {
  createPortal,
  openQQChannel,
  type ChannelOptions,
  type ChannelIssue,
  type Result,
  type Source,
  type Scope,
} from "../../../../modules/qq-portal/src"
import { scopeKey } from "../../../../modules/qq-portal/src/routing"

const root = process.env.IM_QQ_WIRE_TEST_ROOT
if (!root) throw new Error("Use tools.qq_portal_smoke with an isolated root")
const home = await mkdtemp(path.join(root, "qq-portal-"))
const directory = path.join(home, "location")
await mkdir(directory)
const checks: string[] = []
const requests: unknown[] = []
let ordinaryActivated = false
const entered = Promise.withResolvers<void>()
const release = Promise.withResolvers<void>()
const followupEntered = Promise.withResolvers<void>()
const followupRelease = Promise.withResolvers<void>()
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method !== "POST") return Response.json({ data: [] })
    requests.push(await request.json())
    const serial = requests.length
    if (serial === 1) {
      entered.resolve()
      await release.promise
    }
    if (serial === 6) {
      followupEntered.resolve()
      await followupRelease.promise
    }
    const chunks = [
      {
        choices: [
          { index: 0, delta: { role: "assistant", content: `QQ fixture response ${serial}` }, finish_reason: null },
        ],
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
            `data: ${JSON.stringify({ id: `qq-fixture-${serial}`, object: "chat.completion.chunk", model: "baseline", created: 0, ...chunk })}\n\n`,
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
      name: "Local QQ acceptance model",
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
const policy = { botID: "10001", allowedUsers: ["20001", "20002"], allowedGroups: ["30001"] }
const peer: Scope = { botID: policy.botID, kind: "private", peerID: "20001" }
const group: Scope = { botID: policy.botID, kind: "group", peerID: "30001" }
function message(id: string, text: string, quote?: string) {
  return {
    post_type: "message",
    message_type: "private",
    self_id: policy.botID,
    user_id: "20001",
    message_id: id,
    message: [...(quote ? [{ type: "reply", data: { id: quote } }] : []), { type: "text", data: { text } }],
  }
}
async function boot(plugins = true) {
  const ready = Promise.withResolvers<StorageDomain>()
  const other = Promise.withResolvers<StorageDomain>()
  const app = await create({
    database: { path: path.join(home, "application.sqlite") },
    models: { fetch: false },
    runtime: { managedDirectory: directory },
    config: { directory: path.join(home, "config"), project: false, claude: false, content: JSON.stringify(config) },
    fs: { filewatcher: false },
    log: { level: "error", emit: () => {} },
    plugins: [
      {
        id: "must-remain-blocked",
        setup: () => {
          ordinaryActivated = true
        },
      },
    ],
    trustedPlugins: plugins
      ? [
          {
            id: "qq-portal",
            setup: (context) => {
              ready.resolve(context.storage)
            },
          },
          {
            id: "unrelated-plugin",
            setup: (context) => {
              other.resolve(context.storage)
            },
          },
        ]
      : [],
  })
  return { app, storage: ready.promise, other: other.promise }
}
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 30_000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Native QQ observation deadline")
    await Bun.sleep(20)
  }
}
async function bounded<T>(value: Promise<T>) {
  let timer: ReturnType<typeof setTimeout>
  try {
    return await Promise.race([
      value,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("QQ fixture event deadline")), 30_000)
      }),
    ])
  } finally {
    clearTimeout(timer!)
  }
}

import { Effect, Exit, Scope as EffectScope } from "effect"
import { fakeOneBot, until as observe } from "../../../../modules/qq-portal/test/fixture/onebot"

async function owned(options: ChannelOptions) {
  const scope = Effect.runSync(EffectScope.make())
  const channel = await Effect.runPromise(
    Effect.acquireRelease(
      Effect.sync(() => openQQChannel(options)),
      (value) => Effect.promise(() => value.close()),
    ).pipe(Effect.provideService(EffectScope.Scope, scope)),
  )
  return { channel, close: () => Effect.runPromise(EffectScope.close(scope, Exit.void)) }
}

let host: Awaited<ReturnType<typeof boot>> | undefined
let owner: Awaited<ReturnType<typeof owned>> | undefined
const onebot = fakeOneBot()
try {
  host = await boot()
  let app = host.app
  const first = await app.session.create({
    title: "Wire first",
    location: { directory },
    model: { providerID: "baseline", id: "baseline" },
  })
  const second = await app.session.create({
    title: "Wire second",
    location: { directory },
    model: { providerID: "baseline", id: "baseline" },
  })
  await app.permission.list({ sessionID: first.id })
  const storage = await bounded(host.storage)
  const portal = createPortal({ policy, storage, session: app.session, controls: { allowedUsers: ["20001"] } })
  await portal.bind(peer, first.id)
  const received: { source: Source; result: Result }[] = [],
    issues: ChannelIssue[] = []
  const options: ChannelOptions = {
    portal,
    policy,
    connection: { url: onebot.url, token: onebot.token },
    onResult: (value) => {
      received.push(value)
    },
    onIssue: (value) => issues.push(value),
  }
  const denied = await owned({ ...options, connection: { url: onebot.url, token: "wrong-fixture-token" } })
  assert.equal((await denied.channel.ready).phase, "unavailable")
  assert.equal((await app.session.get({ sessionID: first.id })).id, first.id)
  assert.equal(requests.length, 0)
  await denied.close()
  checks.push(
    "the real application starts and reads its native sessions without QQ; a rejected token cannot block the core",
  )
  owner = await owned(options)
  assert.equal((await owner.channel.ready).phase, "online")
  assert.deepEqual(
    onebot.calls.map((call) => call.action),
    ["get_login_info", "get_status"],
  )
  assert(onebot.upgrades.every((row) => !row.url.includes(onebot.token)))
  checks.push("an authenticated universal socket verifies the expected bot and online status before forwarding events")

  await app.session.prompt({ sessionID: second.id, text: "Desktop holds native execution", delivery: "queue" })
  await bounded(entered.promise)
  const task = message("701", "Network queued input")
  onebot.event(message("700", "/bind " + second.id))
  onebot.event(task)
  onebot.event(task)
  await observe(() => received.filter((row) => row.source.messageID === "701").length === 2)
  const pending = await app.session.inbox.list({ sessionID: second.id })
  assert.equal(pending.length, 1)
  const admitted = received.find((row) => row.source.messageID === "701")!.result
  assert(
    admitted.status === "accepted" && admitted.target.kind === "session" && admitted.target.sessionID === second.id,
  )
  assert.deepEqual(await storage.get("binding:" + scopeKey(peer)), { kind: "session", sessionID: second.id })
  assert.deepEqual(await app.session.inbox.list({ sessionID: first.id }), [])
  checks.push(
    "wire bind and following input keep ingress order, and repeated delivery admits one input into the original native Inbox",
  )

  onebot.event({ ...message("900", "No group at"), message_type: "group", group_id: group.peerID })
  onebot.event({ ...message("901", "Outsider"), user_id: "99999" })
  onebot.event({ ...message("902", "Self"), user_id: policy.botID })
  onebot.event({ ...message("903", "Sent event"), post_type: "message_sent" })
  onebot.event({ ...message("904", "/list"), user_id: "20002" })
  await observe(() => received.some((row) => row.source.messageID === "904"))
  const forbidden = received.find((row) => row.source.messageID === "904")!.result
  assert(forbidden.status === "control" && forbidden.result.kind === "forbidden")
  assert(!received.some((row) => ["900", "901", "902", "903"].includes(row.source.messageID)))
  assert.equal(requests.length, 1)
  checks.push(
    "authenticated wire traffic still obeys member, group-at, outgoing/self and separate control authorization rules",
  )

  const source: Source = { scope: peer, actorID: "20001", messageID: "701" }
  const taskReply = await owner.channel.send(source, "Acknowledged [CQ:literal] text")
  assert(taskReply.status === "sent")
  await portal.linkReply(source, taskReply.messageID)
  const supplement = message("702", "Only one supplement", taskReply.messageID)
  onebot.event(supplement)
  onebot.event(supplement)
  await observe(() => received.filter((row) => row.source.messageID === "702").length === 2)
  const amended = await app.session.inbox.list({ sessionID: second.id })
  assert.equal(amended.length, 1)
  assert(amended[0]?.type === "user")
  assert.equal(amended[0].payload.text, "Network queued input\n\nOnly one supplement")
  assert.equal(onebot.calls.filter((call) => call.action === "send_private_msg").length, 1)
  assert.equal(requests.length, 1)
  checks.push(
    "a loopback send acknowledgment yields the actual returned message ID for a native reply alias and quoted append deduplicates in place",
  )

  onebot.event(message("703", "/list"))
  await observe(() => received.some((row) => row.source.messageID === "703"))
  const catalog = received.find((row) => row.source.messageID === "703")!.result
  assert(catalog.status === "control" && catalog.result.kind === "conversations")
  const listSource: Source = { scope: peer, actorID: "20001", messageID: "703" }
  const listReply = await owner.channel.send(listSource, "Fixture conversation list")
  assert(listReply.status === "sent")
  await portal.linkControlView(listSource, catalog.result.viewID, listReply.messageID)
  const index =
    catalog.result.items.findIndex((item) => item.target.kind === "session" && item.target.sessionID === first.id) + 1
  assert(index > 0)
  onebot.event(message("704", "/bind " + index, listReply.messageID))
  await observe(() => received.some((row) => row.source.messageID === "704"))
  assert.deepEqual(await storage.get("binding:" + scopeKey(peer)), { kind: "session", sessionID: first.id })
  assert.equal((await app.session.inbox.list({ sessionID: second.id })).length, 1)
  checks.push(
    "a control view is published only after the loopback API returns its reply ID and numbered selection preserves its original target",
  )

  await bounded(owner.close())
  owner = undefined
  await observe(() => onebot.sockets.size === 0)
  assert.equal(requests.length, 1)
  assert.equal((await app.session.inbox.list({ sessionID: second.id })).length, 1)
  assert.equal((await app.session.get({ sessionID: first.id })).id, first.id)
  checks.push(
    "the caller's native Scope closes the channel while model execution remains held and queued native work is neither cancelled nor resumed",
  )
  owner = await owned(options)
  assert.equal((await owner.channel.ready).phase, "online")
  const before = received.filter((row) => row.source.messageID === "701").length
  onebot.event(task)
  await observe(() => received.filter((row) => row.source.messageID === "701").length === before + 1)
  const repeated = received.filter((row) => row.source.messageID === "701").at(-1)!.result
  assert(repeated.status === "accepted" && repeated.duplicate)
  assert.deepEqual(repeated.target, { kind: "session", sessionID: second.id })
  assert.equal((await app.session.inbox.list({ sessionID: second.id })).length, 1)
  assert.deepEqual(await app.session.inbox.list({ sessionID: first.id }), [])
  assert.equal(requests.length, 1)
  checks.push(
    "an explicit new channel after close reconciles the old source despite rebinding without another native input or model request",
  )
  onebot.event({
    post_type: "meta_event",
    meta_event_type: "heartbeat",
    self_id: policy.botID,
    status: { online: false, good: false },
  })
  await observe(() => owner!.channel.state().phase === "unavailable")
  assert.equal((await app.session.get({ sessionID: second.id })).id, second.id)
  await Bun.sleep(20)
  assert.equal(onebot.upgrades.length, 3)
  assert.equal(onebot.calls.filter((call) => call.action === "get_status").length, 2)
  await owner.close()
  owner = undefined
  checks.push(
    "a heartbeat-reported disconnect leaves the real core available and does not start polling, reconnecting or replaying API calls",
  )

  release.resolve()
  await until(async () =>
    (await app.session.context({ sessionID: second.id })).some(
      (row) =>
        row.type === "assistant" &&
        row.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("") === "QQ fixture response 2",
    ),
  )
  assert.equal(requests.length, 2)
  const history = await app.session.context({ sessionID: second.id })
  assert.equal(history.filter((row) => row.type === "user").length, 2)
  const delivered = history.find((row) => row.id === admitted.inputID)
  assert(delivered?.type === "user" && delivered.text === "Network queued input\n\nOnly one supplement")
  assert.deepEqual(await portal.sourceFor({ kind: "session", sessionID: second.id }, admitted.inputID), {
    status: "found",
    source,
  })
  checks.push("only the native runner drains its original FIFO with one appended input after the channel has gone away")
  await app.close()
  host = await boot(false)
  app = host.app
  assert.equal((await app.session.get({ sessionID: second.id })).id, second.id)
  assert.equal((await app.session.inbox.list({ sessionID: second.id })).length, 0)
  assert.equal(requests.length, 2)
  assert.equal(ordinaryActivated, false)
  checks.push("SQLite reopens and native history remains usable without a QQ plugin, connection, login or model replay")
  assert.equal(issues.length, 0)
  console.log(
    JSON.stringify({
      status: "passed",
      checks,
      model_requests: requests.length,
      actual_qq_connection: false,
      external_messages_sent: 0,
      production_credentials_used: false,
      loopback_messages_sent: onebot.calls.filter((call) => call.action.startsWith("send_")).length,
      loopback_connection_attempts: onebot.upgrades.length,
      lifecycle: "explicit-owner-effect-scope",
    }),
  )
} finally {
  release.resolve()
  followupRelease.resolve()
  await owner?.close()
  await host?.app.close()
  onebot.close()
  upstream.stop(true)
}
