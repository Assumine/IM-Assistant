// Real native inputs, scoped business tools, official MCP, SQLite and loopback I/O. No production credentials.
import assert from "node:assert/strict"
import { mkdir, mkdtemp } from "node:fs/promises"
import path from "node:path"
import { Effect, Exit, Scope } from "effect"
import { OpenCode } from "@opencode/client"
import { Capability } from "@opencode/schema/capability"
import { ServerFetch } from "../src/fetch"
import { createResearchModule, jsonCollector, type Caller, type Draft } from "../../../../modules/research/src/index"
import { Client, StreamableHTTPClientTransport } from "../../../../modules/research/test/mcp-client"

const root = process.env.IM_RESEARCH_CHECKPOINT_TEST_ROOT
if (!root) throw new Error("Use isolated native checkpoint acceptance")
const home = await mkdtemp(path.join(root, "checkpoints-")), directory = path.join(home, "location")
await mkdir(directory); await mkdir(path.join(home, "config"))
const checks: string[] = [], reads: string[] = [], modelRequests: unknown[] = []
const main = { entered: Promise.withResolvers<unknown[]>(), release: Promise.withResolvers<void>() }
const unknown = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }
const long = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }
let seeding = true, loseReceipt = false
const source = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url)
  reads.push((seeding ? "seed:" : "run:") + url.pathname)
  if (!seeding && url.pathname === "/source-a") return Response.json({ problem: "safe-read-failure" })
  if (!seeding && url.pathname === "/long") { long.entered.resolve(); await long.release.promise }
  return Response.json({ title: url.searchParams.get("title") ?? "Fixture", method: url.pathname })
} })
function object(value: unknown): Record<string, unknown> { assert(value && typeof value === "object"); return value as Record<string, unknown> }
function toolOutput(value: unknown) {
  const content = object(value).content
  const text = typeof content === "string" ? content : (content as { type: string; text?: string }[]).filter((part) => part.type === "text").map((part) => part.text).join("")
  return object(JSON.parse(text))
}
const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (request.method !== "POST") return Response.json({ data: [] })
  const body = await request.json() as { messages: { role: string; content: unknown }[] }
  modelRequests.push(body)
  const boundary = body.messages.findLastIndex((message) => message.role === "user")
  const text = JSON.stringify(body.messages[boundary]?.content), replies = body.messages.slice(boundary + 1).filter((message) => message.role === "tool")
  const trunk = replies[0] ? toolOutput(replies[0]).checkpoint : undefined
  const plan = text.includes("WORK_MAIN") ? [
    { roundID: "identify", category: "film", action: "identify", input: { title: "Fixture" } },
    { roundID: "resource-one", category: "film", action: "resources", input: { title: "Fixture", edition: "first" }, after: [trunk] },
  ] : text.includes("CANCEL_SOURCE") ? [{ roundID: "cancel", category: "film", action: "long", input: { title: "Fixture" } }] : []
  const next = plan[replies.length]
  if (!next && text.includes("WORK_MAIN")) { main.entered.resolve(replies.map(toolOutput)); await main.release.promise }
  if (text.includes("HOLD_UNKNOWN")) { unknown.entered.resolve(); await unknown.release.promise }
  const delta = next ? { role: "assistant", tool_calls: [{ index: 0, id: "call_scope_" + modelRequests.length, type: "function", function: { name: "research_run", arguments: JSON.stringify(next) } }] }
    : { role: "assistant", content: "FIXTURE_DONE" }
  return new Response([
    { choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: next ? "tool_calls" : "stop" }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } },
  ].map((chunk) => "data: " + JSON.stringify({ id: "scope-model-" + modelRequests.length, object: "chat.completion.chunk", model: "fixture", created: 0, ...chunk }) + "\n\n").join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
} })
const config = { model: "fixture/fixture", update: "disable", share: "disabled",
  agents: { build: { permissions: [{ action: "*", resource: "*", effect: "deny" }, { action: "research_*", resource: "*", effect: "allow" }] } },
  providers: { fixture: { name: "Synthetic native-input model", package: "@opencode/ai/providers/openai-compatible",
    settings: { baseURL: `http://127.0.0.1:${upstream.port}/v1`, apiKey: "fixture" },
    models: { fixture: { name: "Fixture", limit: { context: 32000, output: 2048 }, capabilities: { tools: true, input: ["text"], output: ["text"] } } } } },
}
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 30000
  while (!await check()) { if (Date.now() >= deadline) throw new Error("Native checkpoint condition not reached"); await Bun.sleep(1) }
}
async function boot() {
  const research = createResearchModule({ primitives: [jsonCollector({ baseURL: `http://127.0.0.1:${source.port}`, minimumIntervalMs: 0 })] })
  const scope = Effect.runSync(Scope.make())
  const handler = await Effect.runPromise(ServerFetch.make({ database: { path: path.join(home, "native.sqlite") }, models: { fetch: false },
    config: { directory: path.join(home, "config"), project: false, claude: false, content: JSON.stringify(config) },
    runtime: { managedDirectory: directory }, fs: { filewatcher: false },
  }, { modules: [{ ...research, open(context) { return research.open({ ...context, storage: { ...context.storage,
    insert: async (key, value) => {
      if (loseReceipt && /\/step\/\d+\/result$/.test(key)) throw new Error("Fixture lost collection receipt")
      return context.storage.insert(key, value)
    },
  } }) } }] }).pipe(Effect.provideService(Scope.Scope, scope)))
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => handler(request) })
  const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${server.port}`, headers: { "x-opencode-directory": encodeURIComponent(directory) } })
  await client.rpc(Capability.Api).list({}); await research.ready
  return { research, client, async close() { await Effect.runPromise(Scope.close(scope, Exit.void)); server.stop(true) } }
}
type Host = Awaited<ReturnType<typeof boot>>
let host: Host | undefined, mcpServer: ReturnType<typeof Bun.serve> | undefined
const mcpClients: Client[] = [], principals = new Map<string, Caller>()
async function mcp(caller: Caller) {
  const token = crypto.randomUUID(); principals.set(token, caller)
  const client = new Client({ name: "native-input-checkpoint-fixture", version: "1.0.0" }); mcpClients.push(client)
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpServer!.port}/mcp`), { requestInit: { headers: { authorization: "Bearer " + token } } }))
  return client
}
async function call(client: Client, name: string, args: Record<string, unknown>, error = false) {
  const result = await client.callTool({ name: "research_" + name, arguments: args })
  assert.equal(!!result.isError, error, JSON.stringify(result.content))
  return toolOutput(result)
}
const params = (action: string, roundID = action, input: unknown = { title: "Fixture" }, after?: unknown[]) =>
  ({ roundID, category: "film", action, input, ...(after ? { after } : {}) })
try {
  host = await boot()
  const helper = await host.client.session.create({ title: "Checkpoint assistance fixture", location: { directory } })
  const helperRef = { backendID: "opencode", threadID: helper.id }
  await host.research.call(helperRef, "adopt", { expectedVersion: 0 })
  for (const [id, action] of [["identify", "identify"], ["source-a", "resources"], ["source-b", "resources"], ["long", "long"], ["effect", "effect"]]) {
    const definition: Draft = { id: id!, revision: "1", category: "film", action: action!, title: id!, tools: ["read_json"],
      inputSchema: { type: "object", properties: { title: { type: "string" }, edition: { type: "string" } }, required: ["title"] },
      outputSchema: { type: "object", properties: { title: { type: "string" }, method: { type: "string" } }, required: ["title", "method"] },
      program: `const page = await tools.read_json({path:${JSON.stringify("/" + id)}+"?title="+encodeURIComponent(input.title)}); if(page.status!=="success") return page; if(page.value.problem) return {status:"failure",reason:page.value.problem}; return {status:"success",value:page.value}`,
    }
    assert.notEqual(object(await host.research.call(helperRef, "save", { definition })).status, "error")
    const test = object(await host.research.call(helperRef, "test", { testID: "seed-" + id, pathID: id, revision: "1", input: { title: "Fixture" } }))
    assert.equal(object(test.outcome).status, "success")
    assert.notEqual(object(await host.research.call(helperRef, "publish", { pathID: id, revision: "1", testID: "seed-" + id })).status, "error")
  }
  seeding = false
  mcpServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: host.research.mcp(async (token) => principals.get(token)) })
  const runner = await host.client.session.create({ title: "Native checkpoint runner", location: { directory } })
  const work = await host.client.session.prompt({ sessionID: runner.id, text: "WORK_MAIN" })
  const nativeResults = await main.entered.promise
  const trunk = object(nativeResults[0]), resource = object(nativeResults[1])
  assert.equal(trunk.status, "success"); assert.equal(resource.status, "success")
  const position = await host.client.session.input.position({ sessionID: runner.id, inputID: work.id })
  assert.equal(position.rootID, work.id); assert.equal(position.status, "open")
  checks.push("native AI business tools resolve their actual input root from the original assistant message, without model-supplied ownership")
  const ref = { backendID: "opencode", threadID: runner.id, inputID: work.id }, external = await mcp(ref)
  const repeat = await call(external, "run", params("identify", "new-label"))
  assert.equal(repeat.reused, true); assert.equal(repeat.checkpoint, trunk.checkpoint)
  await call(external, "run", params("resources", "resource-two", { title: "Fixture", edition: "second" }, [trunk.checkpoint]))
  assert.equal(reads.filter((value) => value === "run:/identify").length, 1)
  assert.equal(reads.filter((value) => value === "run:/source-a").length, 1)
  assert.equal(reads.filter((value) => value === "run:/source-b").length, 2)
  assert((await host.research.history()).every((value) => value.rounds === 0))
  checks.push("native tools and official MCP calls share one input-wide score ledger; changing call labels or parameters cannot reset a failed branch or rerun the valid trunk")
  const unbound = await mcp({ backendID: "opencode", threadID: runner.id })
  await call(unbound, "run", params("identify"), true)
  await call(external, "run", { ...params("identify"), inputID: "msg_forged" }, true)
  checks.push("unbound MCP callers and forged input-ownership arguments are rejected before any collection")
  main.release.resolve()
  await until(async () => (await host!.client.session.input.position({ sessionID: runner.id, inputID: work.id })).status === "closed")
  const completed = await host.client.session.input.position({ sessionID: runner.id, inputID: work.id })
  assert.equal(completed.experimental?.outcome, "completed")
  const history = await host.research.history()
  assert.equal(history.find((value) => value.id === "identify")!.score, 1.2)
  assert.equal(history.find((value) => value.id === "source-a")!.score, 0.9)
  assert.equal(history.find((value) => value.id === "source-b")!.score, 1.2)
  assert.equal(history.find((value) => value.id === "source-b")!.rounds, 1)
  checks.push("native input completion folds each path once: a failed resource does not penalize the trunk and two successes do not double historical rewards")
  await Promise.all(mcpClients.splice(0).map((client) => client.close())); mcpServer.stop(true); mcpServer = undefined
  await host.close(); host = await boot()
  mcpServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: host.research.mcp(async (token) => principals.get(token)) })
  const restored = await mcp(ref), beforeRestore = reads.length
  assert.equal((await call(restored, "run", params("identify", "after-restart"))).reused, true)
  const old = await call(restored, "run", params("identify", "different-target", { title: "Other film" }))
  assert.equal(old.reason, "native-input-not-open")
  assert.equal(reads.length, beforeRestore)
  assert.deepEqual(await host.research.history(), history)
  checks.push("real SQLite restart restores scoped checkpoints and the single history receipt; a closed input can read its result but cannot execute another target")
  const pending = await host.client.session.create({ title: "Lost receipt native input", location: { directory } })
  const pendingWork = await host.client.session.prompt({ sessionID: pending.id, text: "HOLD_UNKNOWN" })
  await unknown.entered.promise
  const pendingClient = await mcp({ backendID: "opencode", threadID: pending.id, inputID: pendingWork.id })
  const pendingTrunk = await call(pendingClient, "run", params("identify"))
  loseReceipt = true
  await call(pendingClient, "run", params("effect", "effect", { title: "Fixture" }, [pendingTrunk.checkpoint]), true)
  loseReceipt = false
  const lost = await call(pendingClient, "run", params("effect", "renamed", { title: "Fixture" }, [pendingTrunk.checkpoint]))
  assert.equal(lost.status, "uncertain")
  assert.equal(lost.reason, "collection-incomplete-review-required")
  await call(pendingClient, "run", params("resources", "another-method", { title: "Fixture" }, [pendingTrunk.checkpoint]))
  assert.equal(reads.filter((value) => value === "run:/effect").length, 1)
  const catalog = object(await host.research.call(helperRef, "paths", {}))
  assert.equal((catalog.requests as unknown[]).length, 1)
  assert.equal((object(lost.recovery).checkpoints as unknown[]).length, 1)
  checks.push("an injected receipt-write failure on native SQLite-backed storage blocks replay and alternative I/O, preserves the valid trunk and admits only one contextual assistance request through the native Inbox")
  unknown.release.resolve()
  await until(async () => (await host!.client.session.input.position({ sessionID: pending.id, inputID: pendingWork.id })).status === "closed")
  assert.equal((await host.research.history()).find((value) => value.id === "identify")!.rounds, 1)
  const cancel = await host.client.session.create({ title: "Native source cancellation", location: { directory } })
  const cancelWork = await host.client.session.prompt({ sessionID: cancel.id, text: "CANCEL_SOURCE" })
  await long.entered.promise
  await host.client.session.interrupt({ sessionID: cancel.id })
  await until(async () => (await host!.client.session.input.position({ sessionID: cancel.id, inputID: cancelWork.id })).status === "closed")
  assert.equal((await host.client.session.input.position({ sessionID: cancel.id, inputID: cancelWork.id })).experimental?.outcome, "interrupted")
  assert.equal((await host.research.history()).find((value) => value.id === "long")!.rounds, 0)
  assert.equal(reads.filter((value) => value === "run:/long").length, 1)
  long.release.resolve()
  checks.push("stopping the original native input aborts its source call, retains interruption provenance and does not misclassify cancellation as path unreliability")
  const ordinary = await host.client.session.create({ title: "Unrelated conversation", location: { directory } })
  const normal = await host.client.session.prompt({ sessionID: ordinary.id, text: "ORDINARY_OK" })
  await until(async () => (await host!.client.session.input.position({ sessionID: ordinary.id, inputID: normal.id })).status === "closed")
  assert.equal((await host.client.session.input.position({ sessionID: ordinary.id, inputID: normal.id })).experimental?.outcome, "completed")
  checks.push("unrelated native conversations remain usable after research interruption; no competing task queue or background model loop is introduced")
  console.log(JSON.stringify({ status: "passed", checks, source_requests: reads.length, source_reads: reads,
    model_requests: modelRequests.length, official_mcp_client: true, native_sqlite: true, native_input_owner: true,
    actual_websites: false, actual_qq_connection: false, private_data_migrated: false, production_switch: false }))
} finally {
  loseReceipt = false; main.release.resolve(); unknown.release.resolve(); long.release.resolve()
  await Promise.all(mcpClients.map((client) => client.close())); mcpServer?.stop(true)
  await host?.close(); upstream.stop(true); source.stop(true)
}
