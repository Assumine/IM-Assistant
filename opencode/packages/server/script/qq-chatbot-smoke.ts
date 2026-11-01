// Isolated native HTTP/SQLite acceptance. No real QQ account, private memory or external message.
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect, Exit, Scope } from "effect"
import { OpenCode } from "@opencode/client"
import { Capability } from "@opencode/schema/capability"
import type { ApplicationModule } from "@opencode/plugin/promise/application"
import { ServerFetch } from "../src/fetch"
import { createChatbotModule, nativeSessionID, type ChatInput, type Receipt } from "../../../../modules/qq-chatbot/src/index"
import { configuredModule, createPortal, type Result } from "../../../../modules/qq-portal/src/index"
import { fakeOneBot, until } from "../../../../modules/qq-protocol/test/fixture/onebot"

const root = process.env.IM_QQ_CHATBOT_TEST_ROOT
if (!root) throw new Error("Use the isolated QQ chatbot acceptance runner")
const home = await mkdtemp(path.join(root, "qq-chatbot-")), directory = path.join(home, "location")
await mkdir(directory)
await mkdir(path.join(home, "config"))
const checks: string[] = [], requests: { messages: unknown[]; tools?: unknown[] }[] = []
const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
const upstream = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    if (request.method !== "POST") return Response.json({ data: [] })
    const body = await request.json() as { messages: unknown[]; tools?: unknown[] }
    requests.push(body)
    const serial = requests.length
    if (serial === 1) { entered.resolve(); await release.promise }
    const content = JSON.stringify(body.messages).includes("You MUST use this format for your response")
      ? "## Objective\n- Keep the group conversation and member identities.\n\n## Important Context\n- Member A is 20001; Member B is 20002."
      : "Synthetic chat reply " + serial
    return new Response([
      { choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
    ].map((value) => "data: " + JSON.stringify({ id: "chat-fixture-" + serial, object: "chat.completion.chunk", model: "baseline", created: 0, ...value }) + "\n\n").join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } })
  },
})
const config = {
  model: "baseline/baseline", update: "disable", share: "disabled",
  providers: { baseline: { name: "Synthetic model", package: "@opencode/ai/providers/openai-compatible",
    settings: { baseURL: `http://127.0.0.1:${upstream.port}/v1`, apiKey: "synthetic" },
    models: { baseline: { name: "Synthetic chat model", limit: { context: 32000, output: 1024 },
      capabilities: { tools: true, input: ["text"], output: ["text"] } } } } },
}
const fake = fakeOneBot()
const portalPolicy = { botID: "10001", allowedUsers: ["20001"], allowedGroups: [] }
await writeFile(path.join(home, "channels.json"), JSON.stringify({ version: 1, enabled: true,
  accounts: [{ policy: portalPolicy, url: fake.url, tokenEnv: "IM_QQ_TOKEN_CHATBOT_TEST" }] }))
const settings = () => ({ location: { directory }, accounts: [
  { botID: "10002", model: { providerID: "baseline", id: "baseline" },
    persona: { name: "Synthetic Sheep", prompt: "SYNTHETIC_SHEEP_PERSONA: reply briefly in character, and identify members by ID." } },
  { botID: "10003", model: { providerID: "baseline", id: "baseline" },
    persona: { name: "Synthetic Neighbor", prompt: "SYNTHETIC_NEIGHBOR_PERSONA: an independent test persona." } },
] })
const input = (id: string, text: string, peerID = "30001", actorID = "20001", kind: "private" | "group" = "group", botID = "10002"): ChatInput =>
  ({ scope: { botID, kind, peerID }, actorID, messageID: id, text, displayName: actorID === "20001" ? "Member A" : "Member B" })
function accepted(value: Receipt) { assert(value.status === "accepted", JSON.stringify(value)); return value }
async function bounded<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout>
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("QQ chat fixture deadline")), 30000) })]) }
  finally { clearTimeout(timer!) }
}

type Context = Parameters<ApplicationModule["open"]>[0]
async function boot(mode: "good" | "missing-model" | "missing-all" | "changed-persona" | "absent" = "good", forwarding = true) {
  const options = settings()
  if (mode === "missing-model") options.accounts[0]!.model.id = "unavailable"
  if (mode === "missing-all") for (const account of options.accounts) account.model.id = "unavailable"
  if (mode === "changed-persona") options.accounts[0]!.persona.prompt = "Changed persona requires an explicit migration"
  const chat = mode === "absent" ? undefined : createChatbotModule(options)
  let context: Context | undefined, portalContext: Context | undefined, observerContext: Context | undefined
  const results: Result[] = []
  const portal = forwarding ? await configuredModule(home, { IM_QQ_TOKEN_CHATBOT_TEST: fake.token }, {
    onResult: (value) => { results.push(value.result) },
  }) : undefined
  const modules: ApplicationModule[] = [
    ...(chat ? [{ ...chat, open(value: Context) { context = value; return chat.open(value) } }] : []),
    ...(portal ? [{ ...portal, open(value: Context) { portalContext = value; return portal.open(value) } }] : []),
    { id: "unrelated-observer", open(value) { observerContext = value; return { close: async () => {} } } },
  ]
  const scope = Effect.runSync(Scope.make())
  let server: ReturnType<typeof Bun.serve> | undefined
  try {
    const handler = await Effect.runPromise(ServerFetch.make({
      database: { path: path.join(home, "native.sqlite") }, models: { fetch: false },
      config: { directory: path.join(home, "config"), project: false, claude: false, content: JSON.stringify(config) },
      runtime: { managedDirectory: directory }, fs: { filewatcher: false },
    }, { modules }).pipe(Effect.provideService(Scope.Scope, scope)))
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => handler(request) })
    const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${server.port}`, headers: { "x-opencode-directory": encodeURIComponent(directory) } })
    const api = client.rpc(Capability.Api)
    await until(async () => (await api.list({})).some((item) => item.id === "unrelated-observer" && item.state === "active"), 30000)
    if (chat) await bounded(chat.ready)
    if (portal) await until(async () => (await api.list({})).some((item) => item.id === "qq-portal" && item.health?.phase === "ready"), 30000)
    return { chat, client, api, context, portalContext, observerContext, results,
      async close() { await Effect.runPromise(Scope.close(scope, Exit.void)); server!.stop(true) } }
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.void)); server?.stop(true); throw error
  }
}
type Host = Awaited<ReturnType<typeof boot>>
async function finished(host: Host, receipt: Extract<Receipt, { status: "accepted" }>) {
  await until(async () => (await host.client.experimental.session.input.output({ sessionID: receipt.sessionID, inputID: receipt.inputID })).status === "closed", 30000)
}
async function portalTask(host: Host, id: number) {
  assert(host.portalContext)
  const session = await host.client.session.create({ title: "Native task portal", location: { directory } })
  const portal = createPortal({ storage: host.portalContext.storage, session: host.client.session, policy: portalPolicy })
  await portal.bind({ botID: "10001", kind: "private", peerID: "20001" }, session.id)
  fake.event({ post_type: "message", self_id: "10001", message_type: "private", user_id: "20001", message_id: id,
    message: [{ type: "text", data: { text: "Native portal task " + id } }] })
  await until(() => host.results.some((value) => value.status === "accepted" && value.sessionID === session.id), 30000)
  const receipt = host.results.find((value) => value.status === "accepted" && value.sessionID === session.id)
  assert(receipt?.status === "accepted")
  await finished(host, { status: "accepted", sessionID: session.id, inputID: receipt.inputID, duplicate: false })
  return session.id
}

let host: Host | undefined
try {
  host = await boot("good", false)
  assert(host.chat && host.context && host.observerContext)
  assert.equal(await host.chat.ready, "ready")
  assert(!(await host.api.list({})).some((value) => value.id === "qq-portal"))
  checks.push("the standalone chat ApplicationModule starts with original native clients/KV and no task forwarding module")

  const message = input("1", "GROUP_A_MEMBER_A")
  const concurrent = await Promise.all([host.chat.receive(message), host.chat.receive(message)])
  const first = accepted(concurrent[0]!), repeated = accepted(concurrent[1]!)
  assert.equal(first.sessionID, repeated.sessionID); assert.equal(first.inputID, repeated.inputID)
  assert.equal(concurrent.filter((value) => value.status === "accepted" && value.duplicate).length, 1)
  await bounded(entered.promise)
  assert.equal(requests.length, 1)
  checks.push("concurrent duplicate ingress coalesces only admission and produces one original native input and model request")

  const next = accepted(await host.chat.receive(input("2", "GROUP_A_MEMBER_B", "30001", "20002")))
  assert.equal(next.sessionID, first.sessionID)
  const pending = await host.client.session.inbox.list({ sessionID: first.sessionID })
  assert.equal(pending.length, 1); assert.equal(pending[0]?.id, next.inputID)
  assert.equal(JSON.parse(pending[0]!.type === "user" ? pending[0]!.payload.text : "null").sender.id, "20002")
  assert.equal((await host.chat.receive(input("2", "GROUP_A_MEMBER_B", "30001", "20002"))).status, "accepted")
  assert.deepEqual(await host.chat.receive(input("2", "CHANGED_BODY", "30001", "20002")), { status: "blocked", reason: "input-conflict" })
  assert.deepEqual(await host.chat.receive(input("2", "GROUP_A_MEMBER_B", "30001", "20001")), { status: "blocked", reason: "input-conflict" })
  assert.equal((await host.client.session.inbox.list({ sessionID: first.sessionID })).length, 1)
  const cancelled = accepted(await host.chat.receive(input("9", "WITHDRAWN_SHOULD_NOT_RUN")))
  await host.client.session.inbox.cancel({ sessionID: cancelled.sessionID, inboxID: cancelled.inputID })
  await host.chat.receive(input("9", "WITHDRAWN_SHOULD_NOT_RUN"))
  assert.deepEqual((await host.client.session.inbox.list({ sessionID: first.sessionID })).map((value) => value.id), [next.inputID])
  checks.push("member B shares the group context, retains explicit identity and queues natively while changed body/member replays are refused")

  const others = await Promise.all([
    host.chat.receive(input("1", "PRIVATE_A_ONLY", "20001", "20001", "private")),
    host.chat.receive(input("1", "GROUP_B_ONLY", "30002")),
    host.chat.receive(input("1", "OTHER_BOT_ONLY", "30001", "20001", "group", "10003")),
    host.chat.receive(input("1", "PRIVATE_B_ONLY", "20002", "20002", "private")),
  ])
  for (const receipt of others) await finished(host, accepted(receipt))
  assert.equal(new Set([first.sessionID, ...others.map((value) => accepted(value).sessionID)]).size, 5)
  for (const receipt of others) {
    const context = await host.client.session.context({ sessionID: accepted(receipt).sessionID })
    const users = context.filter((value) => value.type === "user")
    assert.equal(users.length, 1)
    assert(!JSON.stringify(users).includes("GROUP_A_MEMBER_A"))
  }
  assert.equal(requests.length, 5)
  assert(JSON.stringify(requests[0]).includes("SYNTHETIC_SHEEP_PERSONA"))
  assert(!JSON.stringify(requests[0]).includes("SYNTHETIC_NEIGHBOR_PERSONA"))
  assert(requests.every((request) => !request.tools?.length))
  checks.push("different groups, private peers and bot accounts use separate native histories/personas without inheriting tool permissions")

  const metadata = await host.context.storage.scan({ prefix: "" })
  assert(!JSON.stringify(metadata).includes("GROUP_A_MEMBER_A"))
  assert(!JSON.stringify(metadata).includes("SYNTHETIC_SHEEP_PERSONA"))
  assert.deepEqual(await host.observerContext.storage.scan({ prefix: "" }), { entries: [] })
  const sessions = await host.client.session.list({ limit: 100 })
  assert.equal(sessions.data.length, 5)
  assert.deepEqual((await host.client.session.get({ sessionID: first.sessionID })).permissions,
    [{ action: "*", resource: "*", effect: "deny" }])
  checks.push("plugin KV contains only scoped identity/fingerprint metadata while original Session history and deny-all tool rules remain authoritative")

  const sentinel = path.join(home, "outside-managed-sentinel.txt")
  await writeFile(sentinel, "NEVER_READ_SENTINEL_CONTENT")
  const literal = { path: sentinel, url: "https://example.invalid/not-a-loader", text: "@file:" + sentinel }
  await host.client.experimental.session.instructions.entry.put({ sessionID: first.sessionID, key: "literal-test", value: literal })
  assert.deepEqual((await host.client.experimental.session.instructions.entry.list({ sessionID: first.sessionID })).find((value) => value.key === "literal-test")?.value, literal)

  await host.api.stop({ id: "qq-chatbot" })
  assert.deepEqual(await host.chat.receive(input("3", "STOPPED_INPUT")), { status: "unavailable" })
  assert.equal((await host.client.session.inbox.list({ sessionID: first.sessionID })).length, 1)
  release.resolve()
  await finished(host, next)
  assert.equal(requests.length, 6)
  assert(!JSON.stringify(requests).includes("WITHDRAWN_SHOULD_NOT_RUN"))
  assert(JSON.stringify(requests.at(-1)).includes("outside-managed-sentinel.txt"))
  assert(!JSON.stringify(requests).includes("NEVER_READ_SENTINEL_CONTENT"))
  await host.client.experimental.session.instructions.entry.remove({ sessionID: first.sessionID, key: "literal-test" })
  assert(JSON.stringify(requests.at(-1)).includes("GROUP_A_MEMBER_A"))
  assert(JSON.stringify(requests.at(-1)).includes("GROUP_A_MEMBER_B"))
  const memberB = (await host.client.session.context({ sessionID: first.sessionID })).find((row) => row.id === next.inputID)
  assert(memberB?.type === "user")
  assert.equal(JSON.parse(memberB.text).sender.id, "20002")
  checks.push("stopping chat blocks new ingress without interrupting an admitted native run or its original queued successor")
  checks.push("replaying a natively withdrawn message never creates another queued task or model request")
  checks.push("native API-managed instruction JSON keeps file/URL markers literal without reading outside the managed directory")

  await host.close(); host = await boot()
  assert(host.chat && host.context)
  const restarted = accepted(await host.chat.receive(message))
  assert.equal(restarted.duplicate, true); assert.equal(restarted.sessionID, first.sessionID)
  assert.equal(requests.length, 6)
  assert.equal((await host.client.session.inbox.list({ sessionID: first.sessionID })).length, 0)
  const instructions = await host.client.experimental.session.instructions.entry.list({ sessionID: first.sessionID })
  assert.equal(instructions.length, 1)
  assert(JSON.stringify(instructions[0]).includes("SYNTHETIC_SHEEP_PERSONA"))
  checks.push("native SQLite restart retains personality, sender-aware history and duplicate admission without model replay")

  const beforeCompaction = requests.length
  await host.client.session.compact({ sessionID: first.sessionID, delivery: "queue" })
  await until(async () => (await host!.client.session.context({ sessionID: first.sessionID })).some((row) => row.type === "compaction" && row.status === "completed"), 30000)
  assert(requests.length > beforeCompaction)
  const after = accepted(await host.chat.receive(input("3", "AFTER_NATIVE_COMPACTION", "30001", "20002")))
  await finished(host, after)
  assert(JSON.stringify(requests.at(-1)).includes("SYNTHETIC_SHEEP_PERSONA"))
  const info = await host.client.session.get({ sessionID: first.sessionID })
  assert(info.tokens.input > 0)
  const compactedCount = requests.length
  const renamed = accepted(await host.chat.receive({ ...message, displayName: "Member A renamed" }))
  assert.equal(renamed.duplicate, true)
  assert.equal(requests.length, compactedCount)
  checks.push("manual native compaction and real usage counters remain native; durable persona is still supplied after compaction")
  checks.push("member display-name changes after compaction do not change identity, overwrite history or re-admit an old message")

  await host.api.stop({ id: "qq-portal" })
  const withoutPortal = accepted(await host.chat.receive(input("4", "CHAT_AFTER_PORTAL_STOP")))
  await finished(host, withoutPortal)
  assert.equal((await host.api.list({})).find((row) => row.id === "qq-chatbot")?.health?.phase, "ready")
  checks.push("stopping the real forwarding module does not stop the independent chat resource or native generation")

  const deleted = accepted(others[3]!)
  await host.client.session.remove({ sessionID: deleted.sessionID })
  const beforeDeletedReplay = requests.length
  assert.deepEqual(await host.chat.receive(input("1", "PRIVATE_B_ONLY", "20002", "20002", "private")), { status: "uncertain" })
  assert(!(await host.client.session.list({ limit: 100 })).data.some((session) => session.id === deleted.sessionID))
  assert.equal(requests.length, beforeDeletedReplay)
  checks.push("a retained binding cannot resurrect deleted native chat history and replay its previously admitted input")

  await host.close(); host = await boot("missing-model")
  assert(host.chat)
  assert.equal(await host.chat.ready, "degraded")
  assert.equal((await host.api.list({})).find((row) => row.id === "qq-chatbot")?.health?.phase, "degraded")
  assert.deepEqual(await host.chat.receive(input("5", "MISSING_MODEL_INPUT")), { status: "unavailable" })
  const independent = accepted(await host.chat.receive(input("5", "OTHER_ACCOUNT_STILL_USABLE", "30001", "20001", "group", "10003")))
  await finished(host, independent)
  await portalTask(host, 901)
  const desktop = await host.client.session.create({ location: { directory }, title: "Independent desktop" })
  const desktopInput = await host.client.session.prompt({ sessionID: desktop.id, text: "DESKTOP_REMAINS_USABLE" })
  await finished(host, { status: "accepted", sessionID: desktop.id, inputID: desktopInput.id, duplicate: false })
  checks.push("one missing chat model is isolated from the other chat account, real QQ forwarding and ordinary native desktop sessions")

  await host.close(); host = await boot("missing-all")
  assert(host.chat)
  assert.equal(await host.chat.ready, "unavailable")
  assert.deepEqual(await host.chat.receive(input("6", "ALL_CHAT_MODELS_UNAVAILABLE")), { status: "unavailable" })
  await portalTask(host, 904)
  checks.push("all chat models unavailable leave the chat module explicitly unavailable without disabling the actual forwarding resource")

  await host.close(); host = await boot("changed-persona")
  assert(host.chat)
  assert.deepEqual(await host.chat.receive(input("5", "NO_SILENT_PROFILE_REPLACEMENT")), { status: "blocked", reason: "configuration-changed" })
  assert(!(await host.client.session.context({ sessionID: first.sessionID })).some((row) => row.type === "user" && row.text.includes("NO_SILENT_PROFILE_REPLACEMENT")))
  await portalTask(host, 902)
  checks.push("a conflicting personality/model binding is refused rather than overwriting a live retained conversation or affecting the other plugin")

  await host.close(); host = await boot("absent")
  assert(!(await host.api.list({})).some((row) => row.id === "qq-chatbot"))
  assert.equal((await host.client.session.get({ sessionID: nativeSessionID(message.scope) })).id, first.sessionID)
  await portalTask(host, 903)
  checks.push("removing the chat module leaves its native historical sessions readable and the actual forwarding plugin functional")

  console.log(JSON.stringify({ status: "passed", checks, model_requests: requests.length,
    shared_native_conversations: 5, actual_qq_connection: false, production_credentials_used: false,
    external_messages_sent: 0, private_data_migrated: false, configured_chat_transport: false }))
} finally { release.resolve(); await host?.close(); fake.close(); upstream.stop(true) }
