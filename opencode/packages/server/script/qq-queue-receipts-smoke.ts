// Real application/SQLite/Inbox and pinned Codex service; all accounts, transports and models are loopback fixtures.
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect, Exit, Scope } from "effect"
import { OpenCode } from "@opencode/client"
import { ConversationBackend } from "@opencode/schema/conversation-backend"
import { ServerFetch } from "../src/fetch"
import {
  CodexSessionAdapter,
  createSharedProfile,
  nativeModule,
  stopSharedService,
} from "../../../../modules/codex-native/src"
import { configuredModule, type Source, type Result } from "../../../../modules/qq-portal/src"
import { inputID } from "../../../../modules/qq-portal/src/routing"
import { fakeOneBot, until, type Call } from "../../../../modules/qq-portal/test/fixture/onebot"

const root = process.env.IM_QQ_QUEUE_RECEIPTS_ROOT,
  executable = process.env.IM_CODEX_EXECUTABLE
if (!root || !executable) throw new Error("Use an isolated queue receipt acceptance root")
const home = await mkdtemp(path.join(root, "queue-receipts-"))
await mkdir(path.join(home, "config"))
const checks: string[] = [],
  requests: { native: boolean; body: unknown }[] = [],
  results: { source: Source; result: Result }[] = [],
  issues: string[] = []
const gates = {
  session: Array.from({ length: 3 }, () => Promise.withResolvers<void>()),
  native: Array.from({ length: 2 }, () => Promise.withResolvers<void>()),
}
const unknownRecall = new Set<number>(),
  recalled: number[] = []
const fake = fakeOneBot({
  call(socket, call) {
    if (call.action !== "delete_msg") return
    assert(typeof call.params.message_id === "number")
    const id = call.params.message_id
    recalled.push(id)
    fake.answer(socket, call, null, unknownRecall.has(id) ? "async" : "ok", unknownRecall.has(id) ? 1 : 0)
    return true
  },
})
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method !== "POST") return Response.json({ data: [] })
    const native = new URL(request.url).pathname.endsWith("/responses")
    requests.push({ native, body: await request.json() })
    const serial = requests.filter((item) => item.native === native).length
    await gates[native ? "native" : "session"][serial - 1]?.promise
    if (!native)
      return new Response(
        [
          {
            choices: [
              { index: 0, delta: { role: "assistant", content: "Session result " + serial }, finish_reason: null },
            ],
          },
          {
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
          },
        ]
          .map((value) => "data: " + JSON.stringify(value) + "\n\n")
          .join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      )
    const item = {
      id: "msg_receipt_" + serial,
      type: "message",
      role: "assistant",
      phase: "final_answer",
      status: "completed",
      content: [{ type: "output_text", text: "Native result " + serial, annotations: [] }],
    }
    return new Response(
      [
        { type: "response.created", response: { id: "resp_receipt_" + serial, status: "in_progress" } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress" } },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            id: "resp_receipt_" + serial,
            status: "completed",
            output: [item],
            usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
          },
        },
      ]
        .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        .join(""),
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
const profile = await createSharedProfile(path.join(home, "codex"), {
  id: "fixture",
  model: "local-fixture",
  baseURL: `http://127.0.0.1:${upstream.port}/v1`,
  keyName: "IM_FIXTURE_KEY",
})
const launch = { executable, profile, apiKey: "fixture-only" },
  native = await CodexSessionAdapter.open(launch)
const policy = { botID: "10001", allowedUsers: ["20001"], allowedGroups: [] }
await writeFile(
  path.join(home, "channels.json"),
  JSON.stringify({
    version: 1,
    enabled: true,
    accounts: [
      {
        policy,
        url: fake.url,
        tokenEnv: "IM_QQ_TOKEN_QUEUE_RECEIPTS",
        queueReplies: true,
        controls: { allowedUsers: ["20001"], backendIDs: ["codex-native"] },
      },
    ],
  }),
)
const config = {
  model: "baseline/baseline",
  update: "disable",
  share: "disabled",
  providers: {
    baseline: {
      name: "Loopback queue receipt fixture",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: `http://127.0.0.1:${upstream.port}/v1`, apiKey: "synthetic" },
      models: {
        baseline: {
          name: "Loopback",
          limit: { context: 32000, output: 1024 },
          capabilities: { tools: false, input: ["text"], output: ["text"] },
        },
      },
    },
  },
}
const source = (id: number): Source => ({
  scope: { botID: "10001", kind: "private", peerID: "20001" },
  actorID: "20001",
  messageID: String(id),
})
const nativeID = (id: number) => inputID(source(id))
const message = (id: number, text: string, quote?: string) => ({
  post_type: "message",
  self_id: "10001",
  message_type: "private",
  user_id: "20001",
  message_id: id,
  message: [...(quote ? [{ type: "reply", data: { id: quote } }] : []), { type: "text", data: { text } }],
})
const recall = (id: number) => ({ ...message(id, ""), post_type: "notice", notice_type: "friend_recall" })
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
function quote(call: Call) {
  assert(Array.isArray(call.params.message))
  const part: unknown = call.params.message.find((part: unknown) => record(part) && part.type === "reply")
  return record(part) && record(part.data) ? part.data.id : undefined
}
function body(call: Call) {
  assert(Array.isArray(call.params.message))
  return call.params.message
    .flatMap((part: unknown) =>
      record(part) && part.type === "text" && record(part.data) && typeof part.data.text === "string"
        ? [part.data.text]
        : [],
    )
    .join("")
}
const sends = (id: number) => fake.calls.filter((call) => call.action.startsWith("send_") && quote(call) === String(id))
const notice = (id: number) => sends(id).filter((call) => body(call).startsWith("已排队"))
function acknowledged(call: Call) {
  const answer = fake.answers.find((value) => value.echo === call.echo)
  assert(answer?.status === "ok" && record(answer.data) && typeof answer.data.message_id === "number")
  return answer.data.message_id
}
const result = (id: number, status: string) =>
  until(() => results.some((value) => value.source.messageID === String(id) && value.result.status === status), 30000)
async function boot() {
  const module = await configuredModule(
    home,
    { IM_QQ_TOKEN_QUEUE_RECEIPTS: fake.token },
    {
      onResult: (value) => {
        results.push(value)
      },
      onIssue: (value) => {
        issues.push(value.kind)
      },
    },
  )
  assert(module)
  const scope = Effect.runSync(Scope.make())
  try {
    const handler = await Effect.runPromise(
      ServerFetch.make(
        {
          database: { path: path.join(home, "app.sqlite") },
          models: { fetch: false },
          config: {
            directory: path.join(home, "config"),
            project: false,
            claude: false,
            content: JSON.stringify(config),
          },
          runtime: { managedDirectory: profile.workspace },
          fs: { filewatcher: false },
        },
        { modules: [module], backends: [nativeModule(launch)] },
      ).pipe(Effect.provideService(Scope.Scope, scope)),
    )
    const fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init)), {
      preconnect: () => undefined,
    })
    const client = OpenCode.make({
      baseUrl: "http://opencode.queue-receipts",
      fetch,
      headers: { "x-opencode-directory": encodeURIComponent(profile.workspace) },
    })
    const backend = client.rpc(ConversationBackend.Api)
    await until(async () => (await backend.list({})).some((item) => item.id === "codex-native"), 30000)
    return {
      client,
      backend,
      rawLog: (sessionID: string) =>
        fetch("http://opencode.queue-receipts/api/experimental/session/" + sessionID + "/log?follow=false").then(
          (response) => response.text(),
        ),
      close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    }
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    throw error
  }
}
let host: Awaited<ReturnType<typeof boot>> | undefined
try {
  host = await boot()
  await until(() => fake.calls.some((call) => call.action === "get_status"), 30000)
  const session = await host.client.session.create({
    title: "Queue receipt",
    location: { directory: profile.workspace },
  })
  const other = await host.client.session.create({ title: "New binding", location: { directory: profile.workspace } })
  fake.event(message(200, "/bind " + session.id))
  await result(200, "control")
  await host.client.session.prompt({
    sessionID: session.id,
    id: "msg_desktop_queue_receipt",
    text: "Desktop current task",
    delivery: "queue",
  })
  await until(() => requests.length === 1, 30000)
  fake.event(message(201, "Cancel this queued task"))
  await result(201, "accepted")
  assert.equal(notice(201).length, 1)
  assert(body(notice(201)[0]!).includes("当前队列1"))
  const firstNotice = acknowledged(notice(201)[0]!)
  fake.event(message(201, "Cancel this queued task"))
  await until(() => results.filter((value) => value.source.messageID === "201").length === 2)
  assert.equal(notice(201).length, 1)
  assert.equal(requests.length, 1)
  checks.push(
    "a busy desktop native task and QQ input share one real Inbox; the original message gets one correctly quoted queue receipt",
  )
  fake.event(message(202, "/bind " + other.id))
  await result(202, "control")
  fake.event(recall(201))
  await result(201, "withdrawn")
  await until(() => recalled.includes(firstNotice), 30000)
  assert.equal((await host.client.session.inbox.list({ sessionID: session.id })).length, 0)
  assert.equal((await host.client.session.inbox.list({ sessionID: other.id })).length, 0)
  checks.push(
    "recalling the task after rebinding cancels only its frozen original pending input and recalls only its bot queue notice",
  )
  fake.event(message(203, "/bind " + session.id))
  await result(203, "control")
  fake.event(message(204, "Cancel via notice alias"))
  await result(204, "accepted")
  const aliasNotice = acknowledged(notice(204)[0]!)
  fake.event(message(205, "/unqueue", String(aliasNotice)))
  await result(205, "control")
  await until(() => recalled.includes(aliasNotice), 30000)
  assert.equal((await host.client.session.inbox.list({ sessionID: session.id })).length, 0)
  checks.push(
    "the actual acknowledged queue notice aliases the native task; quoting it with unqueue cancels that exact pending item",
  )
  fake.event(message(206, "Run this task"))
  await result(206, "accepted")
  const runNotice = acknowledged(notice(206)[0]!)
  gates.session[0]!.resolve()
  await until(() => requests.filter((request) => !request.native).length === 2, 30000)
  await until(() => recalled.includes(runNotice), 30000)
  fake.event(recall(206))
  await result(206, "unchanged")
  fake.event(message(207, "Cancelled but notice deletion unknown"))
  await result(207, "accepted")
  const failedNotice = acknowledged(notice(207)[0]!)
  unknownRecall.add(failedNotice)
  fake.event(recall(207))
  await result(207, "withdrawn")
  await until(() => recalled.includes(failedNotice) && issues.includes("notification-uncertain"), 30000)
  gates.session[1]!.resolve()
  await until(() => sends(206).some((call) => body(call) === "Session result 2"), 30000)
  assert.equal(requests.filter((request) => !request.native).length, 2)
  assert.equal(recalled.filter((id) => id === failedNotice).length, 1)
  checks.push(
    "promotion clears stale queue text, a running task ignores recall, and failed notice deletion does not block its final reply",
  )
  const ref = (await host.backend.create({ backendID: "codex-native" })).thread.ref
  fake.event(message(300, "/bind backend " + ref.backendID + " " + ref.threadID))
  await result(300, "control")
  await host.backend.send({ ref, inputID: "native_desktop_queue_receipt", text: "Native desktop current task" })
  await until(() => requests.some((request) => request.native), 30000)
  fake.event(message(301, "Cancel native pending task"))
  await result(301, "accepted")
  const nativeNotice = acknowledged(notice(301)[0]!)
  const nativePending = (await native.queue(ref.threadID)).data.find(
    (item) => item.clientUserMessageId === nativeID(301),
  )
  assert(nativePending)
  fake.event(recall(301))
  await result(301, "withdrawn")
  await until(() => recalled.includes(nativeNotice), 30000)
  assert(!(await native.queue(ref.threadID)).data.some((item) => item.id === nativePending.id))
  checks.push(
    "whole Codex cancellation uses its real native submission and confirmed delete response; it creates no shadow Session or second queue",
  )
  fake.event(message(302, "Run native pending task"))
  await result(302, "accepted")
  const nativeRunNotice = acknowledged(notice(302)[0]!)
  gates.native[0]!.resolve()
  await until(() => requests.filter((request) => request.native).length === 2, 30000)
  await until(() => recalled.includes(nativeRunNotice), 30000)
  gates.native[1]!.resolve()
  await until(() => sends(302).some((call) => body(call) === "Native result 2"), 30000)
  assert.equal((await host.client.session.list()).data.length, 2)
  assert.equal(requests.length, 4)
  checks.push(
    "the real native queue drains independently, withdraws stale queue feedback and forwards its final result to the original starting message",
  )
  const sendCount = fake.calls.filter((call) => call.action.startsWith("send_")).length,
    recallCount = recalled.length
  await host.close()
  host = undefined
  results.length = 0
  host = await boot()
  await until(
    () => fake.upgrades.length === 2 && fake.calls.filter((call) => call.action === "get_status").length === 2,
    30000,
  )
  fake.event(message(302, "Run native pending task"))
  await result(302, "accepted")
  fake.event(message(208, "/status"))
  await result(208, "control")
  const events = []
  for await (const event of host.client.experimental.session.log({ sessionID: session.id, follow: false }))
    events.push(event)
  assert(events.some((event) => event.type === "session.inbox.cancelled" && event.data.inboxID === nativeID(201)))
  assert(!events.some((event) => event.type === "session.inbox.enqueued"))
  assert(!JSON.stringify(events).includes("Cancel this queued task"))
  assert.equal(requests.length, 4)
  assert.equal(recalled.length, recallCount)
  assert.equal(recalled.filter((id) => id === failedNotice).length, 1)
  assert.equal(fake.calls.filter((call) => call.action.startsWith("send_")).length, sendCount + 1)
  checks.push(
    "SQLite restart and native catch-up retain notice/recall receipts; lost delete acknowledgment never repeats deletion or model execution",
  )
  checks.push(
    "managed native storage retains body-free cancellation/delivery facts for restart proof, without storing another executable inbox or full input log",
  )
  console.log(
    JSON.stringify({
      status: "passed",
      checks,
      model_requests: requests.length,
      loopback_connections: fake.upgrades.length,
      queue_notices: [201, 204, 206, 207, 301, 302].reduce((sum, id) => sum + notice(id).length, 0),
      recall_attempts: recalled.length,
      actual_qq_connection: false,
      external_messages_sent: 0,
      production_credentials_used: false,
    }),
  )
} catch (error) {
  console.error(JSON.stringify({ checks, requests: requests.length, results, recalls: recalled, issues }))
  const first = results.find((entry) => entry.source.messageID === "201" && entry.result.status === "accepted")?.result
  if (host && first?.status === "accepted" && first.target.kind === "session") {
    const events = []
    for await (const event of host.client.experimental.session.log({
      sessionID: first.target.sessionID,
      follow: false,
    }))
      events.push(
        event.type === "log.synced"
          ? event
          : {
              type: event.type,
              durable: event.durable,
              data: "inboxID" in event.data ? event.data.inboxID : undefined,
            },
      )
    console.error(JSON.stringify({ native_log: events, raw_log: await host.rawLog(first.target.sessionID) }))
  }
  throw error
} finally {
  Object.values(gates)
    .flat()
    .forEach((gate) => gate.resolve())
  await host?.close()
  await native.close()
  await stopSharedService(launch)
  fake.close()
  upstream.stop(true)
}
