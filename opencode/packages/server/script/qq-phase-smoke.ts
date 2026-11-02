// Real product CLI/server, original native SQLite and authenticated loopback only.
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { OpenCode } from "@opencode/client"
import { Capability } from "@opencode/schema/capability"
import { nativeInputID, nativeSessionID } from "../../../../modules/qq-chatbot/src/index"
import { fakeOneBot, until, type Call } from "../../../../modules/qq-protocol/test/fixture/onebot"

const root = process.env.IM_QQ_PHASE_TEST_ROOT
if (!root) throw new Error("Use the isolated QQ phase acceptance runner")
const product = await mkdtemp(path.join(root, "qq-phase-")), entry = path.resolve(import.meta.dirname, "../../im-assistant/src/cli.ts")
const task = fakeOneBot({ botID: "10001", token: "synthetic-task-token" })
const chat = fakeOneBot({ botID: "10002", token: "synthetic-chat-token" })
const other = fakeOneBot({ botID: "10003", token: "synthetic-other-token" })
const checks: string[] = [], requests: { model: string; messages: unknown[] }[] = []
function messageText(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || !("content" in body)) return undefined
  if (typeof body.content === "string") return body.content
  if (!Array.isArray(body.content)) return undefined
  return body.content.filter((part) => part && typeof part === "object" && part.type === "text").map((part) => part.text).join("\n")
}
const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (request.method !== "POST") return Response.json({ data: [] })
  const body = await request.json() as { model: string; messages: unknown[] }
  requests.push(body)
  const texts = body.messages.map(messageText).filter((text) => text !== undefined)
  let observed: { text: string } | undefined
  for (const text of [...texts].reverse()) {
    try { const value = JSON.parse(text); if (value.kind === "qq-message" && typeof value.text === "string") { observed = value; break } } catch { /* Native prose. */ }
  }
  const content = observed ? JSON.stringify({ messages: [{ text: "chat:" + observed.text }] }) : "native:" + texts.at(-1)
  return new Response([
    { choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } },
  ].map((chunk) => "data: " + JSON.stringify(chunk) + "\n\n").join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
} })
const env = (badChatToken = false) => ({ ...process.env, IM_ASSISTANT_DATA_ROOT: product, OPENCODE_DISABLE_MODELS_FETCH: "true",
  IM_QQ_TOKEN_TASK: task.token, IM_QQ_CHAT_TOKEN_SHEEP: badChatToken ? "wrong-synthetic-token" : chat.token, IM_QQ_CHAT_TOKEN_OTHER: other.token })
async function command(args: string[], success = true) {
  const child = Bun.spawn([process.execPath, "run", entry, ...args], { env: env(), stdout: "pipe", stderr: "pipe", windowsHide: true })
  const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  assert.equal(code === 0, success, error)
  for (const secret of [task.token, chat.token, other.token, "wrong-synthetic-token"]) assert(!output.includes(secret) && !error.includes(secret))
  return success ? JSON.parse(output) as { enabled: boolean; accountCount: number; contextGeneration?: number; historyDeleted: boolean } : undefined
}
async function boot(badChatToken = false) {
  const child = Bun.spawn([process.execPath, "run", entry, "serve", "--hostname", "127.0.0.1", "--port", "0"],
    { env: env(badChatToken), stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true })
  const ready = Promise.withResolvers<void>()
  let url: string | undefined, password: string | undefined
  const reading = (async () => {
    const decoder = new TextDecoder(); let buffer = ""
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true }); const lines = buffer.split("\n"); buffer = lines.pop() ?? ""
      for (const line of lines) {
        if (line.startsWith("server listening on ")) url = line.slice(20).trim()
        if (line.startsWith("server password ")) password = line.slice(16).trim()
        if (url && password) ready.resolve()
      }
    }
  })()
  const errors = new Response(child.stderr).text()
  const exited = child.exited.then(() => ready.reject(new Error("Product exited before readiness")))
  const stop = async () => {
    child.kill(); const [, , error] = await Promise.all([child.exited, reading, errors, exited])
    for (const secret of [task.token, chat.token, other.token, "wrong-synthetic-token"]) assert(!error.includes(secret))
  }
  const timer = setTimeout(() => ready.reject(new Error("Product boot deadline")), 30000)
  try { await ready.promise } catch (error) { await stop(); throw error } finally { clearTimeout(timer) }
  assert(url && password)
  const client = OpenCode.make({ baseUrl: url, headers: { authorization: "Basic " + Buffer.from("opencode:" + password).toString("base64"),
    "x-opencode-directory": encodeURIComponent(path.join(product, "session-location")) } })
  return { client, api: client.rpc(Capability.Api), stop }
}
const source = (id: number) => ({ scope: { botID: "10002", kind: "private" as const, peerID: "20001" }, actorID: "20001", messageID: String(id) })
const post = (wire: typeof chat, bot: string, id: number, text: string) => wire.event({ post_type: "message", self_id: bot,
  message_type: "private", user_id: "20001", message_id: id, sender: { user_id: "20001", nickname: "Member" }, message: [{ type: "text", data: { text } }] })
const quote = (call: Call) => Array.isArray(call.params.message)
  ? (call.params.message as { type: string; data: { id?: string } }[]).find((part) => part.type === "reply")?.data.id : undefined
const sends = (wire: typeof chat, id: number) => wire.calls.filter((call) => call.action.startsWith("send_") && quote(call) === String(id))
const chatSettings = () => ({ version: 1, enabled: true, accounts: [
  { botID: "10002", url: chat.url, tokenEnv: "IM_QQ_CHAT_TOKEN_SHEEP", model: { providerID: "baseline", id: "baseline" },
    persona: { name: "Sheep", prompt: "Q4_ORIGINAL_PERSONA" }, policy: { privateUsers: ["20001"], groups: ["30001"] } },
  { botID: "10003", url: other.url, tokenEnv: "IM_QQ_CHAT_TOKEN_OTHER", model: { providerID: "baseline", id: "baseline" },
    persona: { name: "Other", prompt: "Q4_OTHER_PERSONA" }, policy: { privateUsers: ["20001"], groups: ["30001"] } },
] })
let host: Awaited<ReturnType<typeof boot>> | undefined
const state = async (id: string) => (await host!.api.list({})).find((item) => item.id === id)
async function health(id: string, phase: string) { await until(async () => (await state(id))?.health?.phase === phase, 30000) }
async function configure(update: (value: Omit<ReturnType<typeof chatSettings>, "accounts"> & { accounts: (ReturnType<typeof chatSettings>["accounts"][number] & { contextGeneration?: number })[] }) => unknown) {
  const before = await host!.api.settings({ id: "qq-chatbot" })
  return host!.api.configure({ id: "qq-chatbot", revision: before.revision, text: JSON.stringify(update(JSON.parse(before.text))) })
}
try {
  assert.equal((await command(["chat", "qq", "status"]))?.enabled, false)
  await command(["chat", "qq", "init"]); await command(["chat", "qq", "init"], false)
  await command(["chat", "qq", "enable"], false)
  const nativeConfig = path.join(product, "native/config/opencode/opencode.json")
  await writeFile(nativeConfig, JSON.stringify({ update: "disable", share: "disabled", model: "baseline/baseline", providers: { baseline: {
    name: "Loopback", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${upstream.port}/v1`, apiKey: "synthetic" },
    models: { baseline: { name: "Loopback", limit: { context: 32000, output: 1024 }, capabilities: { tools: false, input: ["text"], output: ["text"] } } },
  } } }))
  host = await boot()
  await until(async () => (await state("qq-chatbot"))?.state === "disabled" && (await state("qq-portal"))?.state === "disabled", 30000)
  assert.equal((await host.api.list({})).length, 2)
  assert((await state("qq-chatbot"))?.settings)
  assert.equal(task.upgrades.length + chat.upgrades.length + other.upgrades.length, 0)
  checks.push("the actual product exposes exactly two optional business modules while both default off; settings do not create a third dependency module or a QQ connection")

  const initial = await host.api.settings({ id: "qq-chatbot" })
  await host.api.configure({ id: "qq-chatbot", revision: initial.revision, text: JSON.stringify(chatSettings()) })
  await assert.rejects(host.api.configure({ id: "qq-chatbot", revision: initial.revision, text: initial.text }))
  await assert.rejects(configure((value) => ({ ...value, token: "private-fixture-secret" })), (error) => !JSON.stringify(error).includes("private-fixture-secret"))
  assert.equal((await state("qq-chatbot"))?.state, "disabled")
  assert.equal(chat.upgrades.length, 0)
  const savedSettings = await readFile(path.join(product, "modules/qq-chatbot/channels.json"), "utf8")
  assert(!savedSettings.includes(chat.token)); assert(savedSettings.includes("IM_QQ_CHAT_TOKEN_SHEEP"))
  checks.push("native configuration RPC validates and persists real settings while disabled, rejects stale writers and raw secrets, and reports next-start desired state without pretending it is online")
  await command(["chat", "qq", "disable", ""], false)
  await command(["chat", "qq", "reset", "99999"], false)
  assert.equal(await readFile(path.join(product, "modules/qq-chatbot/channels.json"), "utf8"), savedSettings)
  await host.stop(); host = await boot(); await health("qq-chatbot", "ready")
  assert.equal((await state("qq-portal"))?.state, "disabled")
  post(chat, "10002", 1, "Q4_CHAT_ONLY"); await until(() => sends(chat, 1).length === 1, 30000)
  assert(JSON.stringify(requests.at(-1)).includes("Q4_ORIGINAL_PERSONA")); assert.equal(task.upgrades.length, 0)
  const originalSession = nativeSessionID(source(1).scope)
  assert((await host.client.session.context({ sessionID: originalSession })).some((row) => row.type === "user" && row.text.includes("Q4_CHAT_ONLY")))
  checks.push("chat-only product boot uses its configured native provider/persona and independent member-aware SQLite Session; invalid account selectors never toggle a global switch")

  await command(["chat", "qq", "disable"])
  const taskHome = path.join(product, "modules/qq-portal")
  await mkdir(taskHome, { recursive: true })
  await writeFile(path.join(taskHome, "channels.json"), JSON.stringify({ version: 1, enabled: true, accounts: [{
    policy: { botID: "10001", allowedUsers: ["20001"], allowedGroups: ["30001"] }, url: task.url, tokenEnv: "IM_QQ_TOKEN_TASK", controls: { allowedUsers: ["20001"] },
  }] }))
  await host.stop(); host = await boot(); await health("qq-portal", "ready")
  await until(async () => (await state("qq-chatbot"))?.state === "disabled", 30000)
  const native = await host.client.session.create({ location: { directory: path.join(product, "session-location") }, title: "Task-owned native Session" })
  post(task, "10001", 10, "/bind " + native.id); await until(() => sends(task, 10).length === 1, 30000)
  post(task, "10001", 11, "Q4_TASK_ONLY"); await until(() => sends(task, 11).length === 1, 30000)
  assert.equal(chat.upgrades.length, 1); assert.equal((await host.client.session.context({ sessionID: native.id })).filter((row) => row.type === "user").length, 1)
  checks.push("task-only product boot retains original binding, public task replies and native Inbox while the chat module and its model loop stay off")

  await command(["chat", "qq", "enable"])
  await host.stop(); host = await boot(); await Promise.all([health("qq-portal", "ready"), health("qq-chatbot", "ready")])
  post(chat, "10002", 20, "Q4_CHAT_AND_TASK"); post(task, "10001", 20, "Q4_TASK_AND_CHAT")
  await until(() => sends(chat, 20).length === 1 && sends(task, 20).length === 1, 30000)
  const taskHistory = await host.client.session.context({ sessionID: native.id })
  const chatHistory = await host.client.session.context({ sessionID: originalSession })
  assert(!JSON.stringify(taskHistory).includes("Q4_CHAT_AND_TASK")); assert(!JSON.stringify(chatHistory).includes("Q4_TASK_AND_CHAT"))
  checks.push("both real plugins can use the same peer and message numbers without crossing credentials, task bindings, persona, context or outgoing reply identity")
  await host.api.stop({ id: "qq-chatbot" })
  assert.equal(chat.sockets.size, 0); assert.equal(task.sockets.size, 1)
  post(task, "10001", 21, "Q4_TASK_AFTER_CHAT_STOP"); await until(() => sends(task, 21).length === 1, 30000)
  checks.push("stopping chat via the native module GUI/RPC leaves task forwarding, its original runner and actual QQ connection usable")

  await host.stop(); const beforeRestart = requests.length; host = await boot()
  await Promise.all([health("qq-portal", "ready"), health("qq-chatbot", "ready")])
  assert.equal(requests.length, beforeRestart)
  post(chat, "10002", 20, "Q4_CHAT_AND_TASK"); post(chat, "10002", 22, "Q4_RESTART_BARRIER")
  await until(() => sends(chat, 22).length === 1, 30000)
  assert.equal(sends(chat, 20).length, 1); assert.equal(requests.length, beforeRestart + 1)
  await host.api.stop({ id: "qq-portal" })
  post(chat, "10002", 23, "Q4_CHAT_AFTER_TASK_STOP"); await until(() => sends(chat, 23).length === 1, 30000)
  assert.equal(task.sockets.size, 0)
  checks.push("product restart restores native history and acknowledged output metadata without replay; stopping the task plugin leaves chat independently active")

  await configure((value) => ({ ...value, accounts: value.accounts.map((item) => item.botID === "10002" ? { ...item, policy: { ...item.policy, repliesEnabled: false } } : item) }))
  await host.stop(); host = await boot(); await health("qq-chatbot", "ready")
  const beforeMute = requests.length
  post(chat, "10002", 24, "Q4_OBSERVED_WITHOUT_BACKLOG")
  await until(async () => (await host!.client.session.message.get({ sessionID: originalSession, messageID: nativeInputID(source(24)) }).catch(() => undefined))?.type === "synthetic", 30000)
  assert.equal(requests.length, beforeMute); assert.equal(sends(chat, 24).length, 0)
  assert.deepEqual(await host.client.session.inbox.list({ sessionID: originalSession }), [])
  checks.push("a saved reply-off configuration takes effect over the previous persisted switch and observes native context without queueing, sending or model work")
  await assert.rejects(configure((value) => ({ ...value, accounts: value.accounts.map((item) => item.botID === "10002" ? { ...item, persona: { name: "Lamb", prompt: "Q4_NEW_PERSONA" } } : item) })))
  const reset = await command(["chat", "qq", "reset", "10002"])
  assert.equal(reset?.contextGeneration, 1); assert.equal(reset.historyDeleted, false)
  await configure((value) => ({ ...value, accounts: value.accounts.map((item) => item.botID === "10002" ? { ...item,
    contextGeneration: (item.contextGeneration ?? 0) + 1,
    policy: { ...item.policy, repliesEnabled: true }, persona: { name: "Lamb", prompt: "Q4_NEW_PERSONA" } } : item) }))
  await host.stop(); const beforeReset = requests.length; host = await boot(); await health("qq-chatbot", "ready")
  assert.equal(requests.length, beforeReset)
  post(chat, "10002", 20, "Q4_CHAT_AND_TASK"); post(chat, "10002", 25, "Q4_NEW_CONTEXT")
  await until(() => sends(chat, 25).length === 1, 30000)
  assert.equal(requests.length, beforeReset + 1); assert.equal(sends(chat, 20).length, 1)
  assert(JSON.stringify(requests.at(-1)).includes("Q4_NEW_PERSONA")); assert(!JSON.stringify(requests.at(-1)).includes("Q4_ORIGINAL_PERSONA"))
  assert(!JSON.stringify(requests.at(-1)).includes("Q4_OBSERVED_WITHOUT_BACKLOG"))
  assert((await host.client.session.context({ sessionID: originalSession })).some((row) => row.type === "user" && row.text.includes("Q4_CHAT_ONLY")))
  assert((await host.client.session.get({ sessionID: nativeSessionID(source(25).scope, 2) })).id !== originalSession)
  checks.push("explicit reset/model-persona migration creates a new native context generation, preserves old history and global QQ deduplication, and does not replay observations or old model work")

  await configure((value) => ({ ...value, accounts: value.accounts.map((item) => item.botID === "10003" ? { ...item,
    contextGeneration: 1, model: { providerID: "baseline", id: "missing" } } : item) }))
  await host.stop(); host = await boot(); await Promise.all([health("qq-chatbot", "degraded"), health("qq-portal", "ready")])
  post(chat, "10002", 26, "Q4_MODEL_SIBLING_FAILURE"); post(task, "10001", 26, "Q4_TASK_MODEL_SIBLING_FAILURE")
  await until(() => sends(chat, 26).length === 1 && sends(task, 26).length === 1, 30000)
  checks.push("one chat account's invalid native model is isolated; its sibling and the task plugin continue using their own native Sessions")
  await host.stop(); host = await boot(true); await Promise.all([health("qq-chatbot", "unavailable"), health("qq-portal", "ready")])
  post(task, "10001", 27, "Q4_TASK_AFTER_CHAT_AUTH_FAILURE"); await until(() => sends(task, 27).length === 1, 30000)
  checks.push("chat authentication failure reports actual unavailability and cannot block task forwarding or make a desired configuration appear connected")

  await host.stop()
  await writeFile(path.join(product, "modules/qq-chatbot/channels.json"), '{"version":1,"enabled":true,"token":"private-fixture-secret"}')
  host = await boot(); await health("qq-portal", "ready")
  await until(async () => (await state("qq-chatbot"))?.state === "failed", 30000)
  await assert.rejects(host.api.settings({ id: "qq-chatbot" }), (error) => !JSON.stringify(error).includes("private-fixture-secret"))
  const desktop = await host.client.session.create({ location: { directory: path.join(product, "session-location") }, title: "Desktop remains native" })
  const input = await host.client.session.prompt({ sessionID: desktop.id, text: "Q4_DESKTOP_AFTER_BAD_SETTINGS" })
  await until(async () => (await host!.client.experimental.session.input.output({ sessionID: desktop.id, inputID: input.id })).status === "closed", 30000)
  checks.push("malformed optional chat settings fail closed without credential leakage; the task plugin and ordinary desktop generation remain available")
  assert(!JSON.stringify(requests).includes(chat.token) && !JSON.stringify(requests).includes(task.token))
  console.log(JSON.stringify({ status: "passed", checks, model_requests: requests.length,
    product_entry: "packages/im-assistant/src/cli.ts", business_modules: 2, history_deleted: false,
    actual_qq_connection: false, production_credentials_used: false, external_messages_sent: 0, private_data_migrated: false }))
} catch (error) { console.error(JSON.stringify({ completed_checks: checks.length, last_check: checks.at(-1), model_requests: requests.length })); throw error }
finally { await host?.stop(); task.close(); chat.close(); other.close(); upstream.stop(true) }
