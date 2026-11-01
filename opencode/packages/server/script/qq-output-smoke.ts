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
const fake = fakeOneBot(),
  checks: string[] = [],
  requests: unknown[] = [],
  results: { source: Source; result: Result }[] = []
const entered = Array.from({ length: 3 }, () => Promise.withResolvers<void>()),
  release = Array.from({ length: 3 }, () => Promise.withResolvers<void>())
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
  fake.event(message(905, "Follow up on the old task", String(ack.data.message_id)))
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
  console.log(
    JSON.stringify({
      status: "passed",
      checks,
      model_requests: requests.length,
      loopback_connections: fake.upgrades.length,
      loopback_task_send_attempts: sends(900).length + sends(901).length,
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
