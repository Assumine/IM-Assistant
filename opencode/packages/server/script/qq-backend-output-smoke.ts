// Real pinned Codex service, application Scope/SQLite and loopback OneBot/model only.
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
import { Transport } from "../../../../modules/codex-native/src/transport"
import { configuredModule, type Result, type Source } from "../../../../modules/qq-portal/src"
import { inputID } from "../../../../modules/qq-portal/src/routing"
import { fakeOneBot, until as observe, type Call } from "../../../../modules/qq-portal/test/fixture/onebot"

const root = process.env.IM_QQ_BACKEND_OUTPUT_ROOT,
  executable = process.env.IM_CODEX_EXECUTABLE
if (!root || !executable) throw new Error("Use an isolated native output test profile")
const home = await mkdtemp(path.join(root, "backend-output-")),
  fake = fakeOneBot()
await mkdir(path.join(home, "config"))
const requests: unknown[] = [],
  checks: string[] = [],
  results: { source: Source; result: Result }[] = []
const gates = Array.from({ length: 3 }, () => Promise.withResolvers<void>())
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method !== "POST") return Response.json({ data: [] })
    requests.push(await request.json())
    const serial = requests.length
    await gates[serial - 1]?.promise
    const item = {
      id: `msg_output_${serial}`,
      type: "message",
      role: "assistant",
      status: "completed",
      phase: serial === 1 ? "commentary" : "final_answer",
      content: [{ type: "output_text", text: "Native public reply " + serial, annotations: [] }],
    }
    const output =
      serial === 1
        ? [
            item,
            {
              id: "fc_output_question",
              call_id: "call_output_question",
              type: "function_call",
              status: "completed",
              name: "request_user_input",
              arguments: JSON.stringify({
                questions: [
                  {
                    id: "direction",
                    header: "Direction",
                    question: "Choose a direction",
                    options: [
                      { label: "Simple", description: "Keep it simple" },
                      { label: "Full", description: "Include details" },
                    ],
                  },
                ],
              }),
            },
          ]
        : [item]
    const events = [
      { type: "response.created", response: { id: `resp_output_${serial}`, status: "in_progress" } },
      ...output.flatMap((value, index) => [
        { type: "response.output_item.added", output_index: index, item: { ...value, status: "in_progress" } },
        { type: "response.output_item.done", output_index: index, item: value },
      ]),
      {
        type: "response.completed",
        response: {
          id: `resp_output_${serial}`,
          status: "completed",
          output,
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
      },
    ]
    return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    })
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
        url: fake.url,
        tokenEnv: "IM_QQ_TOKEN_BACKEND_OUTPUT",
        policy,
        controls: { allowedUsers: ["20001"], backendIDs: ["codex-native"] },
      },
    ],
  }),
)
const source = (id: number): Source => ({
  scope: { botID: "10001", kind: "private", peerID: "20001" },
  actorID: "20001",
  messageID: String(id),
})
const nativeID = (id: number) => inputID(source(id))
const message = (id: number, text: string, quote?: string) => ({
  post_type: "message",
  self_id: 10001,
  message_type: "private",
  user_id: 20001,
  message_id: id,
  message: [...(quote ? [{ type: "reply", data: { id: quote } }] : []), { type: "text", data: { text } }],
})
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
    if (Date.now() >= deadline)
      throw new Error(
        `Native output observation deadline; requests=${requests.length}; sends=${fake.calls.filter((call) => call.action.startsWith("send_")).length}`,
      )
    await Bun.sleep(20)
  }
}
async function boot() {
  const qq = await configuredModule(
    home,
    { IM_QQ_TOKEN_BACKEND_OUTPUT: fake.token },
    {
      onResult: (value) => {
        results.push(value)
      },
    },
  )
  assert(qq)
  const scope = Effect.runSync(Scope.make())
  try {
    const handler = await Effect.runPromise(
      ServerFetch.make(
        {
          database: { path: path.join(home, "app.sqlite") },
          models: { fetch: false },
          config: { directory: path.join(home, "config"), project: false, claude: false, content: "{}" },
          runtime: { managedDirectory: profile.workspace },
          fs: { filewatcher: false },
        },
        { modules: [qq], backends: [nativeModule(launch)] },
      ).pipe(Effect.provideService(Scope.Scope, scope)),
    )
    const fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init)), {
      preconnect: () => undefined,
    })
    const client = OpenCode.make({
      baseUrl: "http://opencode.native-output",
      fetch,
      headers: { "x-opencode-directory": encodeURIComponent(profile.workspace) },
    })
    const backend = client.rpc(ConversationBackend.Api)
    await until(async () => (await backend.list({})).some((item) => item.id === "codex-native"))
    return { client, backend, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) }
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    throw error
  }
}
let host: Awaited<ReturnType<typeof boot>> | undefined
try {
  host = await boot()
  await observe(() => fake.calls.some((call) => call.action === "get_status"))
  const first = (await host.backend.create({ backendID: "codex-native" })).thread.ref
  const other = (await host.backend.create({ backendID: "codex-native" })).thread.ref
  // Fixture-only native Plan setup so request_user_input genuinely waits. Product defaults remain unchanged.
  const setup = await Transport.open(launch)
  try {
    await setup.request("thread/settings/update", {
      threadId: first.threadID,
      collaborationMode: {
        mode: "plan",
        settings: { model: "local-fixture", reasoning_effort: null, developer_instructions: null },
      },
    })
  } finally {
    await setup.close()
  }
  fake.event(message(990, "/bind backend codex-native " + first.threadID))
  await observe(() => results.some((value) => value.source.messageID === "990"))
  fake.event(message(1000, "First native task"))
  await until(async () => requests.length === 1)
  fake.event(message(1001, "Second native task"))
  fake.event(message(1003, "/bind backend codex-native " + other.threadID))
  await observe(() => results.some((value) => value.source.messageID === "1003"))
  gates[0]!.resolve()
  await until(async () => sends(1000).length === 1)
  assert.equal(body(sends(1000)[0]!), "Native public reply 1")
  assert.equal(sends(1001).length, 0)
  const open = await host.backend.output({ ref: first, inputID: nativeID(1000) })
  assert(open.status === "open" && open.rootID === nativeID(1000) && open.first?.settled)
  const turnID = open.turnID
  checks.push(
    "real native item completion forwards the first public response to the original QQ input while native human input blocks the next queued task",
  )
  await until(
    async () =>
      !!(await host!.backend.execution({ ref: first })).questions?.some((question) => question.state === "pending"),
  )
  const question = (await host.backend.execution({ ref: first })).questions!.find(
    (question) => question.state === "pending",
  )!
  await host.backend.control({
    backendID: first.backendID,
    control: {
      action: "answer",
      threadID: first.threadID,
      questionID: question.id,
      answers: { direction: ["Simple"] },
    },
  })
  await until(async () => requests.length === 2)
  await host.close()
  host = undefined
  gates[1]!.resolve()
  await until(async () => requests.length === 3)
  const running = (await native.turnStates(first.threadID, { limit: 100 })).data.find(
    (turn) => turn.status === "inProgress",
  )
  assert(running)
  await native.interrupt(first.threadID, running.id)
  gates[2]!.resolve()
  await until(async () =>
    (await native.turnStates(first.threadID, { limit: 100 })).data.some(
      (turn) => turn.id === running.id && turn.status === "interrupted",
    ),
  )
  assert.equal(sends(1000).length, 1)
  assert.equal(sends(1001).length, 0)
  checks.push(
    "closing the QQ/application connection leaves native Codex execution and its queued successor running independently",
  )
  host = await boot()
  await observe(() => fake.calls.filter((call) => call.action === "get_status").length === 2)
  await until(async () => sends(1000).length === 2 && sends(1001).length === 1)
  assert.deepEqual(sends(1000).map(body), ["Native public reply 1", "Native public reply 2"])
  assert.equal(body(sends(1001)[0]!), "本次执行已中断，请在客户端查看当前结果。")
  assert.equal(sends(1002).length, 0)
  const restored = await host.backend.output({ ref: first, inputID: nativeID(1000) })
  assert(restored.status === "closed" && restored.turnID === turnID && restored.rootID === nativeID(1000))
  assert.equal(restored.first?.text, "Native public reply 1")
  assert.equal(restored.last?.text, "Native public reply 2")
  assert.equal(requests.length, 3)
  checks.push(
    "startup/native backend registration catches up final text and a proven interruption without replaying work, changing bindings or changing native turn identity",
  )
  const sent = sends(1000)[1]!,
    ack = fake.answers.find((answer) => answer.echo === sent.echo)
  assert(ack?.status === "ok" && record(ack.data) && typeof ack.data.message_id === "number")
  fake.event(message(1004, "Follow up on the original result", String(ack.data.message_id)))
  await observe(() => results.some((value) => value.source.messageID === "1004"))
  const proposal = results.find((value) => value.source.messageID === "1004")!.result
  assert(
    proposal.status === "confirmation-required" &&
      proposal.target.kind === "backend" &&
      proposal.target.ref.threadID === first.threadID,
  )
  const count = results.length
  fake.event(message(1000, "First native task"))
  fake.event(message(1001, "Second native task"))
  await observe(() => results.length >= count + 2)
  assert.equal(sends(1000).length, 2)
  assert.equal(sends(1001).length, 1)
  assert.equal(requests.length, 3)
  checks.push(
    "actual acknowledged reply aliases resolve the original native task and duplicate inputs only reconcile existing result receipts",
  )
  assert.equal((await host.client.session.list()).data.length, 0)
  assert.equal((await native.queue(other.threadID)).data.length, 0)
  checks.push(
    "whole-backend output and notification recovery create no shadow OpenCode Sessions or second native task queue",
  )
  console.log(
    JSON.stringify({
      status: "passed",
      checks,
      model_requests: requests.length,
      loopback_connections: fake.upgrades.length,
      loopback_task_send_attempts: sends(1000).length + sends(1001).length,
      actual_qq_connection: false,
      external_messages_sent: 0,
      production_credentials_used: false,
    }),
  )
} finally {
  gates.forEach((gate) => gate.resolve())
  await host?.close()
  await native.close()
  await stopSharedService(launch)
  fake.close()
  upstream.stop(true)
}
