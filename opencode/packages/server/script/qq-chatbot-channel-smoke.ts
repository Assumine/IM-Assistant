// Real native HTTP/SQLite and authenticated loopback OneBot. No production account or external send.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir } from "node:fs/promises"
import path from "node:path"
import { Effect, Exit, Scope } from "effect"
import { OpenCode, isConflictError } from "@opencode/client"
import { Capability } from "@opencode/schema/capability"
import type { ApplicationModule } from "@opencode/plugin/promise/application"
import { ServerFetch } from "../src/fetch"
import { createQQChatbot, nativeInputID, nativeSessionID, type ChatIssue, type Receipt } from "../../../../modules/qq-chatbot/src/index"
import type { Source } from "../../../../modules/qq-protocol/src/index"
import { fakeOneBot, until } from "../../../../modules/qq-protocol/test/fixture/onebot"

const root = process.env.IM_QQ_CHAT_CHANNEL_ROOT
if (!root) throw new Error("Use the isolated QQ chat channel acceptance runner")
const home = await mkdtemp(path.join(root, "chat-channel-")), directory = path.join(home, "location")
await mkdir(directory); await mkdir(path.join(home, "config"))
const checks: string[] = [], requests: { messages: unknown[]; model: string }[] = []
const issues: ChatIssue[] = [], inputs: { source: Source; receipt: Receipt }[] = []
const switchEntered = Promise.withResolvers<void>(), switchRelease = Promise.withResolvers<void>()
const closeEntered = Promise.withResolvers<void>(), closeRelease = Promise.withResolvers<void>()
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII="
const file = createHash("md5").update(Buffer.from(png, "base64")).digest("hex") + ".png"
const badFile = "0".repeat(32) + ".png"
const fake = fakeOneBot({ botID: "10002", call(socket, call) {
  if (call.action === "get_image") { fake.answer(socket, call, { base64: png, file: "C:/must-not-read.png", url: "https://example.invalid/must-not-fetch" }); return true }
  if (call.action.startsWith("send_") && JSON.stringify(call.params).includes("UNKNOWN_ACK")) return true
} })
const other = fakeOneBot({ botID: "10003" })
function trigger(messages: unknown[]) {
  for (const message of [...messages].reverse()) {
    if (!message || typeof message !== "object" || !("content" in message)) continue
    const texts = typeof message.content === "string" ? [message.content] : Array.isArray(message.content)
      ? message.content.filter((part) => part && typeof part === "object" && part.type === "text").map((part) => part.text) : []
    for (const text of texts) {
      try { const value = JSON.parse(text); if (value.kind === "qq-message" && typeof value.text === "string") return value.text as string } catch { /* Other native context. */ }
    }
  }
  return "native"
}
const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (request.method !== "POST") return Response.json({ data: [] })
  const body = await request.json() as { messages: unknown[]; model: string }
  requests.push(body)
  const text = trigger(body.messages)
  if (text === "Q3_HOLD_SWITCH") { switchEntered.resolve(); await switchRelease.promise }
  if (text === "Q3_HOLD_CLOSE") { closeEntered.resolve(); await closeRelease.promise }
  const content = text === "Q3_BAD_JSON" ? "DO_NOT_LEAK_THIS_RAW_REPLY" : JSON.stringify({ messages: text === "Q3_SILENT" ? []
    : text === "Q3_MENTION_B" ? [{ text: "叫你呢 [CQ:at,qq=all]", mentions: ["20002"] }, { text: "再说一句", sticker: "smile" }]
    : text === "Q3_FOREIGN" ? [{ text: "错误成员", mentions: ["20099"] }]
    : [{ text: text === "Q3_UNKNOWN_ACK" ? "UNKNOWN_ACK" : "reply:" + text }] })
  return new Response([
    { choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
  ].map((value) => "data: " + JSON.stringify({ id: "channel-" + requests.length, object: "chat.completion.chunk", model: body.model, created: 0, ...value }) + "\n\n").join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } })
} })
const config = { update: "disable", share: "disabled", model: "baseline/vision", providers: { baseline: {
  name: "Loopback", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${upstream.port}/v1`, apiKey: "synthetic" },
  models: { vision: { name: "Vision", limit: { context: 32000, output: 1024 }, capabilities: { tools: false, input: ["text", "image"], output: ["text"] } },
    text: { name: "Text", limit: { context: 32000, output: 1024 }, capabilities: { tools: false, input: ["text"], output: ["text"] } } },
} } }
type Context = Parameters<ApplicationModule["open"]>[0]
async function boot() {
  const chat = createQQChatbot({ location: { directory }, accounts: [
    { botID: "10002", model: { providerID: "baseline", id: "vision" }, persona: { name: "小羊", prompt: "A synthetic Sheep persona, short and playful." },
      connection: { url: fake.url, token: fake.token, requestTimeoutMs: 80 }, images: { maxBytes: 2048 },
      policy: { privateUsers: ["20001"], groups: ["30001", "30002"], repliesEnabled: false, ignoredUsers: ["10001"] },
      stickers: [{ id: "smile", label: "测试微笑", uri: "data:image/png;base64," + png }] },
    { botID: "10003", model: { providerID: "baseline", id: "text" }, persona: { name: "Other", prompt: "Independent synthetic persona." },
      connection: { url: other.url, token: other.token }, images: { maxBytes: 2048 }, policy: { privateUsers: ["20001"], groups: ["30001"] } },
  ], onIssue: (value) => issues.push(value), onInput: (source, receipt) => inputs.push({ source, receipt }) })
  let context: Context | undefined
  const scope = Effect.runSync(Scope.make())
  let server: ReturnType<typeof Bun.serve> | undefined
  try {
    const handler = await Effect.runPromise(ServerFetch.make({ database: { path: path.join(home, "native.sqlite") }, models: { fetch: false },
      config: { directory: path.join(home, "config"), project: false, claude: false, content: JSON.stringify(config) },
      runtime: { managedDirectory: directory }, fs: { filewatcher: false } },
    { modules: [{ ...chat, open(value) { context = value; return chat.open(value) } }] }).pipe(Effect.provideService(Scope.Scope, scope)))
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => handler(request) })
    const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${server.port}`, headers: { "x-opencode-directory": encodeURIComponent(directory) } })
    assert.equal(await chat.ready, "ready")
    assert(context)
    return { chat, context, client, api: client.rpc(Capability.Api), async close() { await Effect.runPromise(Scope.close(scope, Exit.void)); server!.stop(true) } }
  } catch (error) { await Effect.runPromise(Scope.close(scope, Exit.void)); server?.stop(true); throw error }
}
const source = (id: number, peerID = "30001", actorID = "20001", botID = "10002", kind: "private" | "group" = "group"): Source =>
  ({ scope: { botID, kind, peerID }, actorID, messageID: String(id) })
function post(id: number, text: string, actor = "20001", group = "30001", extra: unknown[] = [], bot = "10002", privateChat = false) {
  const event = { post_type: "message", self_id: bot, message_type: privateChat ? "private" : "group", user_id: actor, message_id: id,
    ...(privateChat ? {} : { group_id: group }), sender: { user_id: actor, nickname: "Member " + actor },
    message: [{ type: "text", data: { text } }, ...extra] }
  ;(bot === "10002" ? fake : other).event(event)
}
const sends = () => fake.calls.filter((call) => call.action.startsWith("send_"))
const quote = (call: typeof fake.calls[number]) => (call.params.message as { type: string; data: { id?: string } }[]).find((part) => part.type === "reply")?.data.id
let host: Awaited<ReturnType<typeof boot>> | undefined
async function observed(id: number, botID = "10002") { await until(() => inputs.some((value) => value.source.messageID === String(id) && value.source.scope.botID === botID && value.receipt.status === "observed"), 30000) }
async function delivered(value: Source) { await until(async () => !!await host!.context.storage.get("chat-finished:" + nativeInputID(value)), 30000) }
try {
  host = await boot()
  const isolated = await host.client.session.create({ location: { directory }, model: { providerID: "baseline", id: "vision" } })
  const append = host.client.experimental.session.observation.append
  const context = { sessionID: isolated.id, id: "msg_q3_observation", text: "OBSERVED_CONTEXT", metadata: { observed: true } }
  const first = await append(context), replay = await append(context)
  assert.equal(first.id, replay.id); assert.equal(first.time.created, replay.time.created)
  await assert.rejects(append({ ...context, text: "changed" }), isConflictError)
  const unrelated = await host.client.session.create({ location: { directory } })
  await assert.rejects(append({ ...context, sessionID: unrelated.id }), isConflictError)
  const pending = await host.client.session.prompt({ sessionID: unrelated.id, id: "msg_q3_pending", text: "Must stay pending", resume: false })
  await assert.rejects(append({ ...context, id: pending.id }), isConflictError)
  assert.deepEqual(await host.client.session.inbox.list({ sessionID: isolated.id }), [])
  await host.client.session.inbox.cancel({ sessionID: unrelated.id, inboxID: pending.id })
  assert.equal(requests.length, 0)
  checks.push("native observation append is durable/idempotent and rejects conflicting or foreign pending IDs without queueing or generating")

  post(100, "PRIVATE_DENIED", "20099", "", [], "10002", true)
  post(101, "GROUP_DENIED", "20001", "39999")
  post(102, "BOT_IGNORED", "10001")
  post(1, "Q3_OBSERVE_A"); post(2, "Q3_OBSERVE_B", "20002", "30001", [{ type: "face", data: { id: 14 } }])
  await observed(2)
  const room = nativeSessionID(source(1).scope)
  assert.deepEqual(await host.client.session.inbox.list({ sessionID: room }), [])
  assert.equal(requests.length, 0); assert.equal(sends().length, 0)
  const history = await host.client.session.context({ sessionID: room })
  assert(JSON.stringify(history).includes("QQ表情 14")); assert(!JSON.stringify(history).includes("DENIED"))
  checks.push("private whitelist/group scope/bot exclusions are independent; reply-off reads member-aware native context including QQ faces with zero model calls and pending work")

  await host.chat.setReplies("10002", true)
  post(1, "Q3_OBSERVE_A"); post(3, "Q3_SIMPLE")
  await delivered(source(3))
  assert.equal(requests.length, 1); assert.equal(sends().length, 1); assert.equal(quote(sends()[0]!), "3")
  assert(JSON.stringify(requests[0]).includes("Q3_OBSERVE_A")); assert(JSON.stringify(requests[0]).includes("Q3_OBSERVE_B"))
  checks.push("enabling replies generates only for new eligible input and includes prior observations without replaying them")

  post(4, "Q3_SILENT", "20002"); await delivered(source(4, "30001", "20002"))
  assert.equal(requests.length, 2); assert.equal(sends().length, 1)
  checks.push("automatic group participation permits an empty model reply without forcing every message to receive a response")

  post(5, "Q3_MENTION_B"); await delivered(source(5))
  const multi = sends().filter((call) => quote(call) === "5" || JSON.stringify(call.params).includes("再说一句"))
  assert.equal(sends().length, 3); assert.equal(multi.length, 2)
  assert(JSON.stringify(multi[0]!.params).includes('"qq":"20002"'))
  assert(!JSON.stringify(multi[0]!.params).includes('"qq":"all"'))
  assert(JSON.stringify(multi[1]!.params).includes("base64://")); assert.equal(quote(multi[1]!), undefined)
  const beforeDuplicate = requests.length
  post(5, "Q3_MENTION_B"); await until(() => inputs.filter((value) => value.source.messageID === "5").length === 2, 30000)
  assert.equal(requests.length, beforeDuplicate); assert.equal(sends().length, 3)
  checks.push("multiple short bubbles use actual structured member mentions and authorized sticker bytes; CQ text stays literal and duplicates do not resend")

  post(6, "Q3_FOREIGN", "20001", "30002"); await delivered(source(6, "30002"))
  assert.equal(sends().length, 3); assert(issues.some((value) => value.kind === "invalid-reply"))
  checks.push("members observed in another group cannot be mentioned in this group and invalid plans are rejected before any packet is sent")

  post(7, "Q3_HOLD_SWITCH", "20001", "30001", [{ type: "at", data: { qq: "10002" } }])
  await until(() => requests.some((value) => trigger(value.messages) === "Q3_HOLD_SWITCH"), 30000)
  await host.chat.setReplies("10002", false)
  post(8, "Q3_OFF_B", "20002"); await observed(8)
  await host.chat.setReplies("10002", true); switchRelease.resolve()
  await until(async () => (await host!.client.experimental.session.input.output({ sessionID: room, inputID: nativeInputID(source(7)) })).status === "closed", 30000)
  assert(!sends().some((call) => quote(call) === "7"))
  post(9, "Q3_AFTER_SWITCH"); await delivered(source(9))
  assert(JSON.stringify(requests.at(-1)).includes("Q3_OFF_B")); assert(!requests.some((value) => trigger(value.messages) === "Q3_OFF_B"))
  checks.push("off/on during native generation suppresses the old response permanently and preserves intervening observations without creating an AI backlog")

  post(10, "Q3_IMAGE", "20001", "30001", [{ type: "image", data: { file } }]); await delivered(source(10))
  assert(JSON.stringify(requests.at(-1)).includes(png))
  const beforeUnsupported = requests.length
  post(11, "Q3_TEXT_ONLY_IMAGE", "20001", "30001", [{ type: "image", data: { file } }], "10003")
  await observed(11, "10003")
  assert.equal(requests.length, beforeUnsupported); assert.equal(other.calls.filter((call) => call.action === "get_image").length, 0)
  assert(issues.some((value) => value.kind === "image-model-unsupported" && value.botID === "10003"))
  post(16, "Q3_BAD_IMAGE", "20001", "30001", [{ type: "image", data: { file: badFile } }]); await observed(16)
  assert.equal(requests.length, beforeUnsupported)
  checks.push("authenticated content-verified image bytes reach a vision model; unsupported models or mismatched image hashes are observed as not interpreted without partial generation")

  post(12, "Q3_UNKNOWN_ACK"); await delivered(source(12))
  const unknown = sends().filter((call) => JSON.stringify(call.params).includes("UNKNOWN_ACK"))
  assert.equal(unknown.length, 1); assert(issues.some((value) => value.kind === "send-uncertain"))
  const beforeLostReplay = requests.length
  post(12, "Q3_UNKNOWN_ACK"); await until(() => inputs.filter((value) => value.source.messageID === "12").length === 2, 30000)
  assert.equal(requests.length, beforeLostReplay); assert.equal(sends().filter((call) => JSON.stringify(call.params).includes("UNKNOWN_ACK")).length, 1)
  checks.push("a lost OneBot acknowledgement is retained as unknown and neither model execution nor remote send is retried")

  post(13, "Q3_BAD_JSON"); await delivered(source(13))
  assert(!sends().some((call) => JSON.stringify(call.params).includes("DO_NOT_LEAK")))
  checks.push("malformed model response is reported without exposing internal JSON or raw model text in QQ")

  post(14, "Q3_HOLD_CLOSE", "20001", "30001", [{ type: "at", data: { qq: "10002" } }])
  await until(() => requests.some((value) => trigger(value.messages) === "Q3_HOLD_CLOSE"), 30000)
  await host.api.stop({ id: "qq-chatbot" }); const stoppedSends = sends().length
  closeRelease.resolve()
  await until(async () => (await host!.client.experimental.session.input.output({ sessionID: room, inputID: nativeInputID(source(14)) })).status === "closed", 30000)
  assert.equal(sends().length, stoppedSends)
  await host.close(); host = await boot()
  assert.equal(host.chat.replies("10002")?.enabled, true)
  await delivered(source(14))
  assert.equal(sends().filter((call) => quote(call) === "14").length, 1)
  const recovered = requests.length
  post(5, "Q3_MENTION_B"); post(12, "Q3_UNKNOWN_ACK")
  await until(() => inputs.filter((value) => value.source.messageID === "12").length === 3, 30000)
  assert.equal(requests.length, recovered)
  assert.equal(sends().filter((call) => JSON.stringify(call.params).includes("UNKNOWN_ACK")).length, 1)
  checks.push("stop fences all sends while native work can finish; restart restores only notification watches and persisted reply settings without replaying models or uncertain sends")

  await host.api.stop({ id: "qq-chatbot" })
  const desktop = await host.client.session.create({ location: { directory }, title: "Native desktop remains available" })
  const admitted = await host.client.session.prompt({ sessionID: desktop.id, text: "Desktop independent" })
  await until(async () => (await host!.client.experimental.session.input.output({ sessionID: desktop.id, inputID: admitted.id })).status === "closed", 30000)
  assert.equal(sends().filter((call) => quote(call) === "14").length, 1)
  checks.push("stopping both QQ connections leaves the original native desktop Session fully usable")

  console.log(JSON.stringify({ status: "passed", checks, model_requests: requests.length, loopback_send_attempts: sends().length,
    actual_qq_connection: false, production_credentials_used: false, external_messages_sent: 0, private_data_migrated: false }))
} finally { switchRelease.resolve(); closeRelease.resolve(); await host?.close(); fake.close(); other.close(); upstream.stop(true) }
