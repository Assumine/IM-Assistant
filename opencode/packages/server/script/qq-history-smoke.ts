// Actual application/SQLite/native Inbox with loopback NapCat-compatible history and model services only.
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { ServerWebSocket } from "bun"
import { Effect, Exit, Scope } from "effect"
import { OpenCode } from "@opencode/client"
import { ServerFetch } from "../src/fetch"
import { configuredModule, type Result, type Source } from "../../../../modules/qq-portal/src"
import { inputID } from "../../../../modules/qq-portal/src/routing"
import { historyEvent } from "../../../../modules/qq-portal/test/fixture/history"
import { fakeOneBot, until as observe, type Call } from "../../../../modules/qq-portal/test/fixture/onebot"

const root = process.env.IM_QQ_HISTORY_ROOT
if (!root) throw new Error("Use an isolated QQ history acceptance root")
const home = await mkdtemp(path.join(root, "history-")),
  directory = path.join(home, "location")
await mkdir(directory)
await mkdir(path.join(home, "config"))
const scope = { botID: "10001", kind: "private" as const, peerID: "20001" }
const policy = { botID: "10001", allowedUsers: ["20001"], allowedGroups: [] }
const checks: string[] = [],
  requests: unknown[] = [],
  results: { source: Source; result: Result }[] = []
const rows: ReturnType<typeof historyEvent>[] = [],
  held: { socket: ServerWebSocket<undefined>; call: Call }[] = []
let holdHistory = false
const answer = (socket: ServerWebSocket<undefined>, call: Call) => {
  if (!fake.sockets.has(socket)) return
  const index =
    call.params.message_seq === undefined
      ? rows.length - 1
      : rows.findIndex((row) => String(row.message_id) === call.params.message_seq)
  fake.answer(socket, call, {
    messages: index < 0 ? [] : rows.slice(Math.max(0, index - Number(call.params.count) + 1), index + 1),
  })
}
const fake = fakeOneBot({
  call(socket, call) {
    if (call.action !== "get_friend_msg_history") return
    assert.equal(call.params.user_id, "20001")
    assert.equal(call.params.disable_get_url, true)
    assert.equal(call.params.parse_mult_msg, false)
    if (holdHistory) held.push({ socket, call })
    else answer(socket, call)
    return true
  },
})
const release = Array.from({ length: 4 }, () => Promise.withResolvers<void>())
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method !== "POST") return Response.json({ data: [] })
    requests.push(await request.json())
    const serial = requests.length
    await release[serial - 1]?.promise
    return new Response(
      [
        {
          choices: [
            { index: 0, delta: { role: "assistant", content: "History reply " + serial }, finish_reason: null },
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
  },
})
await writeFile(
  path.join(home, "channels.json"),
  JSON.stringify({
    version: 1,
    enabled: true,
    accounts: [
      {
        url: fake.url,
        tokenEnv: "IM_QQ_TOKEN_HISTORY",
        policy,
        controls: { allowedUsers: ["20001"] },
        history: { provider: "napcat", pageSize: 2, maxPages: 8 },
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
      name: "Loopback history fixture",
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
function post(id: number, sequence: string, text: string, quote?: string) {
  const row = historyEvent(id, sequence, text)
  if (quote) row.message.unshift({ type: "reply", data: { id: quote } })
  rows.push(row)
  fake.event(row)
  return row
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
function quote(call: Call) {
  assert(Array.isArray(call.params.message))
  const value: unknown = call.params.message.find((part: unknown) => record(part) && part.type === "reply")
  return record(value) && record(value.data) ? value.data.id : undefined
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
const nativeID = (id: number) => inputID({ scope, messageID: String(id) })
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 30000
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("History fixture observation deadline")
    await Bun.sleep(20)
  }
}
async function boot() {
  const module = await configuredModule(
    home,
    { IM_QQ_TOKEN_HISTORY: fake.token },
    {
      onResult: (value) => {
        results.push(value)
      },
    },
  )
  assert(module)
  const owner = Effect.runSync(Scope.make())
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
          runtime: { managedDirectory: directory },
          fs: { filewatcher: false },
        },
        { modules: [module] },
      ).pipe(Effect.provideService(Scope.Scope, owner)),
    )
    const fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init)), {
      preconnect: () => undefined,
    })
    return {
      client: OpenCode.make({ baseUrl: "http://opencode.history", fetch }),
      close: () => Effect.runPromise(Scope.close(owner, Exit.void)),
    }
  } catch (error) {
    await Effect.runPromise(Scope.close(owner, Exit.void))
    throw error
  }
}
let host: Awaited<ReturnType<typeof boot>> | undefined
try {
  host = await boot()
  await observe(() => fake.calls.some((call) => call.action === "get_status"))
  const session = await host.client.session.create({ title: "History target", location: { directory } })
  post(700, "100", "/bind " + session.id)
  await observe(() => results.some((value) => value.source.messageID === "700"))
  assert.equal(fake.calls.filter((call) => call.action.endsWith("msg_history")).length, 0)
  post(701, "101", "Baseline task")
  await until(async () => requests.length === 1)
  release[0]!.resolve()
  await observe(() => sends(701).length === 1)
  await until(
    async () =>
      (await host!.client.session.input.position({ sessionID: session.id, inputID: nativeID(701) })).status ===
      "closed",
  )
  checks.push(
    "first use establishes only an observed live checkpoint and never imports arbitrary pre-existing chat history",
  )
  await host.close()
  rows.push(historyEvent(702, "102", "First offline task"))
  const supplement = historyEvent(703, "103", "Offline supplement")
  supplement.message.unshift({ type: "reply", data: { id: "702" } })
  rows.push(supplement, historyEvent(704, "104", "Withdrawn offline task"))
  holdHistory = true
  host = await boot()
  await observe(() => held.length === 1)
  const desktopID = "msg_desktop_history_busy"
  await host.client.session.prompt({
    sessionID: session.id,
    id: desktopID,
    text: "Desktop task while history loads",
    delivery: "queue",
  })
  await until(async () => requests.length === 2)
  assert.equal((await host.client.session.list()).data.length, 1)
  checks.push("the real application and desktop native runner remain available while a scoped history request is held")
  const live = post(705, "105", "New live after login")
  fake.event({ post_type: "notice", notice_type: "friend_recall", self_id: "10001", user_id: "20001", message_id: 704 })
  holdHistory = false
  for (const value of held.splice(0)) answer(value.socket, value.call)
  await observe(() => results.some((value) => value.source.messageID === "705"))
  const pending = await host.client.session.inbox.list({ sessionID: session.id })
  assert.deepEqual(
    pending.map((item) => item.id),
    [nativeID(702), nativeID(705)],
  )
  const parent = pending[0]!,
    successor = pending[1]!
  assert(parent.type === "user" && successor.type === "user")
  assert(parent.payload.text.includes("原发送时间"))
  assert(parent.payload.text.includes(new Date(rows.find((row) => row.message_id === 702)!.time * 1000).toISOString()))
  assert(parent.payload.text.includes("First offline task"))
  assert(parent.payload.text.includes("Offline supplement"))
  assert.equal(successor.payload.text, "New live after login")
  assert.equal(requests.length, 2)
  checks.push(
    "complete history pages enter the same real Inbox in per-peer sequence order; a quoted supplement appends to its original pending input and a buffered live input stays live",
  )
  assert(results.some((value) => value.source.messageID === "704" && value.result.status === "recalled"))
  assert(!pending.some((item) => item.id === nativeID(704) || item.id === nativeID(703)))
  checks.push(
    "a recall observed during history loading suppresses only its recovered pending message without interrupting the active desktop task",
  )
  release[1]!.resolve()
  await until(async () => requests.length === 3)
  assert(JSON.stringify(requests[2]).includes("First offline task"))
  assert(JSON.stringify(requests[2]).includes("Offline supplement"))
  release[2]!.resolve()
  await until(async () => requests.length === 4)
  await observe(() => sends(702).some((call) => body(call) === "History reply 3"))
  assert.equal(sends(703).length, 0)
  assert.equal(sends(704).length, 0)
  release[3]!.resolve()
  await observe(() => sends(705).some((call) => body(call) === "History reply 4"))
  assert.equal(sends(702).length, 1)
  assert.equal(sends(705).length, 1)
  checks.push(
    "only the original native runner drains desktop and recovered QQ work; result notifications quote each original task rather than its supplement or the current live message",
  )
  await until(
    async () =>
      (await host!.client.session.input.position({ sessionID: session.id, inputID: nativeID(705) })).status ===
      "closed",
  )
  const historyReads = fake.calls.filter((call) => call.action.endsWith("msg_history")).length
  assert.equal(historyReads, 4)
  await host.close()
  host = await boot()
  await observe(() => fake.calls.filter((call) => call.action.endsWith("msg_history")).length === historyReads + 1)
  const before = results.length
  fake.event(rows.find((row) => row.message_id === 702)!)
  fake.event(supplement)
  fake.event(live)
  await observe(() => results.length >= before + 3)
  assert.equal(requests.length, 4)
  assert.equal((await host.client.session.inbox.list({ sessionID: session.id })).length, 0)
  assert.equal(sends(701).length, 1)
  assert.equal(sends(702).length, 1)
  assert.equal(sends(705).length, 1)
  const restored = await host.client.session.message.get({ sessionID: session.id, messageID: nativeID(702) })
  assert(restored.type === "user")
  assert.equal(restored.text.split("Offline supplement").length, 2)
  checks.push(
    "SQLite reopen restores the exact history boundary, native inputs, original sources and notification watches; overlapping deliveries never repeat model work, append text or send a result twice",
  )
  assert.equal(fake.upgrades.length, 3)
  assert.equal((await host.client.session.list()).data.length, 1)
  checks.push(
    "recovery uses bounded login-triggered scoped reads, without a second Session, history store, background poller or native execution scheduler",
  )
  console.log(
    JSON.stringify({
      status: "passed",
      checks,
      model_requests: requests.length,
      loopback_connections: fake.upgrades.length,
      loopback_history_reads: fake.calls.filter((call) => call.action.endsWith("msg_history")).length,
      loopback_task_send_attempts: sends(701).length + sends(702).length + sends(705).length,
      actual_qq_connection: false,
      external_messages_sent: 0,
      production_credentials_used: false,
    }),
  )
} finally {
  release.forEach((value) => value.resolve())
  holdHistory = false
  for (const value of held.splice(0)) answer(value.socket, value.call)
  await host?.close()
  fake.close()
  upstream.stop(true)
}
