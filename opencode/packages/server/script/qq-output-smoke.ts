// Original application Scope/SQLite/Session runner and a loopback model/OneBot. Never uses a real account.
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect, Exit, Scope } from "effect"
import { OpenCode } from "@opencode/client"
import { ServerFetch } from "../src/fetch"
import { configuredModule, type Result, type Source } from "../../../../modules/qq-portal/src"
import { decode, inputID } from "../../../../modules/qq-portal/src/routing"
import { fakeOneBot, until as observe, type Call } from "../../../../modules/qq-portal/test/fixture/onebot"

const root = process.env.IM_QQ_OUTPUT_ROOT
if (!root) throw new Error("Use an isolated QQ output acceptance root")
const home = await mkdtemp(path.join(root, "output-")),
  directory = path.join(home, "location")
await mkdir(directory)
await mkdir(path.join(home, "config"))
const originals = new Map<string, { message_id: number; message_type: string; user_id: number; message: unknown[] }>()
const fake = fakeOneBot({
    call(socket, call) {
      if (call.action !== "get_msg") return
      const original = originals.get(String(call.params.message_id))
      fake.answer(
        socket,
        call,
        original ? { ...original, sender: { user_id: original.user_id } } : null,
        original ? "ok" : "failed",
        original ? 0 : 1404,
      )
      return true
    },
  }),
  checks: string[] = [],
  requests: unknown[] = [],
  results: { source: Source; result: Result }[] = []
const entered = Array.from({ length: 4 }, () => Promise.withResolvers<void>()),
  release = Array.from({ length: 4 }, () => Promise.withResolvers<void>())
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method !== "POST") return Response.json({ data: [] })
    requests.push(await request.json())
    const serial = requests.length
    entered[serial - 1]?.resolve()
    await release[serial - 1]?.promise
    return new Response(
      [
        {
          choices: [{ index: 0, delta: { role: "assistant", content: "Public reply " + serial }, finish_reason: null }],
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
const policy = { botID: "10001", allowedUsers: ["20001"], allowedGroups: [] }
await writeFile(
  path.join(home, "channels.json"),
  JSON.stringify({
    version: 1,
    enabled: true,
    accounts: [{ url: fake.url, tokenEnv: "IM_QQ_TOKEN_OUTPUT", policy, controls: { allowedUsers: ["20001"] } }],
  }),
)
const config = {
  model: "baseline/baseline",
  update: "disable",
  share: "disabled",
  providers: {
    baseline: {
      name: "Loopback output fixture",
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
const message = (id: number, text: string, quote?: string) => ({
  post_type: "message",
  self_id: 10001,
  message_type: "private",
  user_id: 20001,
  message_id: id,
  message: [...(quote ? [{ type: "reply", data: { id: quote } }] : []), { type: "text", data: { text } }],
})
const nativeID = (id: number) => {
  const event = decode(message(id, "identity only"), policy)
  assert(event.kind === "message")
  return inputID(event.message)
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
function quote(call: Call) {
  assert(Array.isArray(call.params.message))
  const part: unknown = call.params.message.find((part: unknown) => record(part) && part.type === "reply")
  return record(part) && record(part.data) ? part.data.id : undefined
}
const sends = (id: number) => fake.calls.filter((call) => call.action.startsWith("send_") && quote(call) === String(id))
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
function acknowledged(call: Call) {
  const answer = fake.answers.find((value) => value.echo === call.echo)
  assert(answer?.status === "ok" && record(answer.data) && typeof answer.data.message_id === "number")
  return String(answer.data.message_id)
}
function post(id: number, text: string, quoted: string) {
  const raw = message(id, text, quoted)
  originals.set(String(id), raw)
  fake.event(raw)
}
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 30000
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("Output fixture observation deadline")
    await Bun.sleep(20)
  }
}
async function boot() {
  const module = await configuredModule(
    home,
    { IM_QQ_TOKEN_OUTPUT: fake.token },
    {
      onResult: (value) => {
        results.push(value)
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
          runtime: { managedDirectory: directory },
          fs: { filewatcher: false },
        },
        { modules: [module] },
      ).pipe(Effect.provideService(Scope.Scope, scope)),
    )
    const fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init)), {
      preconnect: () => undefined,
    })
    return {
      client: OpenCode.make({ baseUrl: "http://opencode.output", fetch }),
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
  await observe(() => fake.calls.some((call) => call.action === "get_status"))
  const first = await host.client.session.create({ title: "Original target", location: { directory } })
  const other = await host.client.session.create({ title: "New binding", location: { directory } })
  fake.event(message(890, "/bind " + first.id))
  await observe(() => results.some((value) => value.source.messageID === "890"))
  fake.event(message(900, "First task"))
  await until(async () => requests.length === 1)
  fake.event(message(901, "Second queued task"))
  fake.event(message(902, "Adjust the first task", "900"))
  await observe(() => results.some((value) => value.source.messageID === "902" && value.result.status === "steered"))
  fake.event(message(903, "/bind " + other.id))
  await observe(() => results.some((value) => value.source.messageID === "903"))
  release[0]!.resolve()
  await until(async () => requests.length === 2)
  await observe(() => sends(900).length === 1)
  assert.equal(body(sends(900)[0]!), "Public reply 1")
  assert.equal(sends(901).length, 0)
  checks.push(
    "the first public response is forwarded during the guarded continuation and the pending successor produces no premature reply",
  )
  release[1]!.resolve()
  await until(async () => requests.length === 3)
  await observe(() => sends(900).length === 2)
  assert.deepEqual(sends(900).map(body), ["Public reply 1", "Public reply 2"])
  assert.equal(sends(902).length, 0)
  assert.equal((await host.client.session.context({ sessionID: other.id })).length, 0)
  checks.push(
    "the final response still quotes the original input after a continuation and rebinding while the successor is already running",
  )
  release[2]!.resolve()
  await until(
    async () =>
      (await host!.client.session.input.position({ sessionID: first.id, inputID: nativeID(901) })).status === "closed",
  )
  await observe(() => sends(901).length === 1)
  assert.equal(body(sends(901)[0]!), "Public reply 3")
  const output = await host.client.experimental.session.input.output({ sessionID: first.id, inputID: nativeID(900) })
  assert.equal(output.status, "closed")
  assert.equal(output.first?.text, "Public reply 1")
  assert.equal(output.last?.text, "Public reply 2")
  assert.notEqual(output.first?.messageID, output.last?.messageID)
  assert.equal(
    (await host.client.experimental.session.input.output({ sessionID: other.id, inputID: nativeID(900) })).status,
    "unknown",
  )
  checks.push(
    "native input output reads preserve first/final ownership independently of the latest user, execution busy period and another Session",
  )
  const sent = sends(900)[0]!,
    ack = fake.answers.find((value) => value.echo === sent.echo)
  assert(ack?.status === "ok" && record(ack.data) && typeof ack.data.message_id === "number")
  post(905, "Follow up on the old task", String(ack.data.message_id))
  await observe(() => results.some((value) => value.source.messageID === "905"))
  const proposal = results.find((value) => value.source.messageID === "905")!.result
  assert(
    proposal.status === "confirmation-required" &&
      proposal.target.kind === "session" &&
      proposal.target.sessionID === first.id,
  )
  assert.equal(requests.length, 3)
  checks.push(
    "quoting the actual acknowledged assistant reply resolves its original task and requires cross-Session confirmation instead of dispatching into the new binding",
  )
  await observe(() => sends(905).length === 1)
  const consentPrompt = acknowledged(sends(905)[0]!)
  assert(body(sends(905)[0]!).includes("Original target"))
  assert(body(sends(905)[0]!).includes("/confirm"))
  const beforeDuplicate = results.length
  post(905, "Follow up on the old task", String(ack.data.message_id))
  await observe(() => results.length > beforeDuplicate)
  assert.equal(sends(905).length, 1)
  assert.equal(requests.length, 3)
  checks.push(
    "an acknowledged confirmation prompt quotes its original request once and cannot admit model input before explicit consent",
  )
  await host.close()
  host = await boot()
  await observe(() => fake.calls.filter((call) => call.action === "get_status").length === 2)
  const before = results.length
  fake.event(message(900, "First task"))
  fake.event(message(901, "Second queued task"))
  await observe(() => results.length >= before + 2)
  const restored = await host.client.experimental.session.input.output({ sessionID: first.id, inputID: nativeID(900) })
  assert.equal(restored.last?.text, "Public reply 2")
  assert.equal(sends(900).length, 2)
  assert.equal(sends(901).length, 1)
  assert.equal(requests.length, 3)
  assert.equal((await host.client.session.inbox.list({ sessionID: first.id })).length, 0)
  checks.push(
    "SQLite restart restores output attribution and first/final receipts without repeating native work or sending historical replies again",
  )
  post(906, "/CODEX CONFIRM", consentPrompt)
  await until(async () => requests.length === 4)
  await observe(() => results.some((value) => value.source.messageID === "906"))
  const confirmed = results.find((value) => value.source.messageID === "906")!.result
  assert(confirmed.status === "confirmation-control" && confirmed.result.status === "followup")
  assert.equal(confirmed.result.inputID, nativeID(905))
  assert(confirmed.result.target.kind === "session" && confirmed.result.target.sessionID === first.id)
  assert(JSON.stringify(requests[3]).includes("Follow up on the old task"))
  assert(!JSON.stringify(requests[3]).includes("/CODEX CONFIRM"))
  const beforeRepeat = results.length
  post(906, "/CODEX CONFIRM", consentPrompt)
  await observe(() => results.length > beforeRepeat)
  assert.equal(requests.length, 4)
  assert.equal(sends(906).length, 1)
  release[3]!.resolve()
  await observe(() => sends(905).some((call) => body(call) === "Public reply 4"))
  fake.event(message(908, "/status"))
  await observe(() => results.some((value) => value.source.messageID === "908"))
  const current = results.find((value) => value.source.messageID === "908")!.result
  assert(
    current.status === "control" &&
      current.result.kind === "status" &&
      current.result.target.kind === "session" &&
      current.result.target.sessionID === other.id,
  )
  checks.push(
    "after SQLite restart a quoted confirmation reads its exact original and creates one native linked input without rebinding; command repeats only reconcile and final output quotes the original request",
  )

  post(910, "Decline this follow-up", String(ack.data.message_id))
  await observe(() => sends(910).length === 1)
  const declinePrompt = acknowledged(sends(910)[0]!)
  post(911, "/cancel", declinePrompt)
  await observe(() => results.some((value) => value.source.messageID === "911"))
  const declined = results.find((value) => value.source.messageID === "911")!.result
  assert(declined.status === "confirmation-control" && declined.result.status === "confirmation-declined")
  post(912, "/confirm", declinePrompt)
  await observe(() => results.some((value) => value.source.messageID === "912"))
  const opposite = results.find((value) => value.source.messageID === "912")!.result
  assert(
    opposite.status === "confirmation-control" &&
      opposite.result.status === "confirmation-already-decided" &&
      opposite.result.choice === "decline",
  )
  assert.equal(requests.length, 4)
  checks.push(
    "decline is acknowledged to its own command and remains immutable when a later approval quotes the same prompt; no model work is admitted",
  )

  post(913, "Unavailable original", String(ack.data.message_id))
  await observe(() => sends(913).length === 1)
  originals.delete("913")
  post(914, "/confirm", acknowledged(sends(913)[0]!))
  await observe(() => results.some((value) => value.source.messageID === "914"))
  const unavailable = results.find((value) => value.source.messageID === "914")!.result
  assert(unavailable.status === "confirmation-control" && unavailable.result.status === "confirmation-unavailable")
  post(915, "Recalled original", String(ack.data.message_id))
  await observe(() => sends(915).length === 1)
  fake.event({ post_type: "notice", notice_type: "friend_recall", self_id: 10001, user_id: 20001, message_id: 915 })
  await observe(() => results.some((value) => value.source.messageID === "915" && value.result.status === "unchanged"))
  post(916, "/confirm", acknowledged(sends(915)[0]!))
  await observe(() => results.some((value) => value.source.messageID === "916"))
  const recalled = results.find((value) => value.source.messageID === "916")!.result
  assert(recalled.status === "confirmation-control" && recalled.result.status === "recalled")
  assert.equal(requests.length, 4)
  assert.equal(fake.calls.filter((call) => call.action === "get_msg").length, 4)
  assert.equal((await host.client.session.inbox.list({ sessionID: first.id })).length, 0)
  assert.equal((await host.client.session.context({ sessionID: other.id })).length, 0)
  checks.push(
    "missing or recalled originals return explicit confirmation feedback without guessed payloads, fallback tasks, cancelled predecessors or another native queue",
  )
  console.log(
    JSON.stringify({
      status: "passed",
      checks,
      model_requests: requests.length,
      loopback_connections: fake.upgrades.length,
      loopback_task_send_attempts:
        sends(900).length + sends(901).length + sends(905).filter((call) => body(call) === "Public reply 4").length,
      loopback_original_reads: fake.calls.filter((call) => call.action === "get_msg").length,
      actual_qq_connection: false,
      external_messages_sent: 0,
      production_credentials_used: false,
    }),
  )
} finally {
  release.forEach((value) => value.resolve())
  await host?.close()
  fake.close()
  upstream.stop(true)
}
