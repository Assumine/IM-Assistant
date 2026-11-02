// Isolated native model/tool/SQLite and official MCP client acceptance. No production accounts or websites.
import assert from "node:assert/strict"
import { mkdir, mkdtemp } from "node:fs/promises"
import path from "node:path"
import { Effect, Exit, Scope } from "effect"
import { OpenCode } from "@opencode/client"
import { Capability } from "@opencode/schema/capability"
import { ServerFetch } from "../src/fetch"
import { createResearchModule, jsonCollector, type Draft, type Identity } from "../../../../modules/research/src/index"
import { Client, StreamableHTTPClientTransport } from "../../../../modules/research/test/mcp-client"

const root = process.env.IM_RESEARCH_ASSISTANCE_TEST_ROOT
if (!root) throw new Error("Use isolated research assistance acceptance")
const home = await mkdtemp(path.join(root, "research-role-")), directory = path.join(home, "location")
await mkdir(directory); await mkdir(path.join(home, "config"))
const checks: string[] = [], modelRequests: { tools?: { function: { name: string } }[]; messages: { role: string; content?: unknown }[] }[] = []
let sourceRequests = 0
const source = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  sourceRequests++
  const url = new URL(request.url)
  if (url.pathname === "/login") return new Response("Manual login", { status: 403 })
  if (url.pathname === "/absent") return new Response("Not found", { status: 404 })
  return Response.json({ title: "Synthetic movie", year: 2026 })
} })
const definition: Draft = { id: "movie-information", revision: "1", category: "film", action: "details", title: "Movie detail collection",
  tools: ["read_json"], inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
  outputSchema: { type: "object", properties: { title: { type: "string" }, year: { type: "integer" } }, required: ["title", "year"] },
  program: 'const page = await tools.read_json({path:"/movie?title="+encodeURIComponent(input.title)}); if(page.status !== "success") return page; return {status:"success",value:{title:page.value.title,year:page.value.year}}',
}
const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (request.method !== "POST") return Response.json({ data: [] })
  const body = await request.json() as typeof modelRequests[number]
  modelRequests.push(body)
  const last = body.messages.findLastIndex((value) => value.role === "user"), text = JSON.stringify(body.messages[last]?.content)
  const replies = body.messages.slice(last + 1).filter((value) => value.role === "tool")
  if (text.includes("HOLD_IDENTITY") && !replies.length) { entered.resolve(); await release.promise }
  const plan = text.includes("ADOPT_FIRST") ? [{ name: "research_adopt", args: { expectedVersion: 0 } }]
    : text.includes("ADOPT_SECOND") ? [{ name: "research_adopt", args: { expectedVersion: 1 } }]
    : text.includes("BUILD_COMPLETE_PATH") ? [
      { name: "research_probe", args: { primitiveID: "read_json", input: { path: "/movie" } } },
      { name: "research_save", args: { definition } },
      { name: "research_test", args: { testID: "native-test", pathID: definition.id, revision: "1", input: { title: "Synthetic movie" } } },
      { name: "research_publish", args: { pathID: definition.id, revision: "1", testID: "native-test" } },
    ]
    : text.includes("STALE_EDIT") ? [{ name: "research_save", args: { definition: { ...definition, revision: "old-holder" } } }]
    : text.includes("READ_SHARED_PATHS") ? [{ name: "research_paths", args: {} }]
    : text.includes("RUN_PUBLISHED_PATH") ? [{ name: "research_run", args: { roundID: "native-round", category: "film", action: "details", input: { title: "Synthetic movie" } } }]
    : []
  const next = plan[replies.length]
  const delta = next ? { role: "assistant", tool_calls: [{ index: 0, id: "call_research_" + modelRequests.length, type: "function", function: { name: next.name, arguments: JSON.stringify(next.args) } }] }
    : { role: "assistant", content: "SYNTHETIC_RESEARCH_DONE" }
  return new Response([
    { choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: next ? "tool_calls" : "stop" }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } },
  ].map((chunk) => "data: " + JSON.stringify({ id: "research-model-" + modelRequests.length, object: "chat.completion.chunk", model: "baseline", created: 0, ...chunk }) + "\n\n").join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
} })
const config = { model: "baseline/baseline", update: "disable", share: "disabled",
  agents: { build: { permissions: [{ action: "*", resource: "*", effect: "deny" }, { action: "research_*", resource: "*", effect: "allow" }] } },
  providers: { baseline: { name: "Synthetic model", package: "@opencode/ai/providers/openai-compatible",
    settings: { baseURL: `http://127.0.0.1:${upstream.port}/v1`, apiKey: "synthetic" },
    models: { baseline: { name: "Synthetic model", limit: { context: 32000, output: 2048 }, capabilities: { tools: true, input: ["text"], output: ["text"] } } } } },
}
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 30000
  while (!await check()) { if (Date.now() >= deadline) throw new Error("Research native readiness deadline"); await Bun.sleep(1) }
}
async function boot() {
  const research = createResearchModule({ primitives: [jsonCollector({ baseURL: `http://127.0.0.1:${source.port}`, minimumIntervalMs: 0 })] })
  const scope = Effect.runSync(Scope.make())
  const handler = await Effect.runPromise(ServerFetch.make({ database: { path: path.join(home, "native.sqlite") }, models: { fetch: false },
    config: { directory: path.join(home, "config"), project: false, claude: false, content: JSON.stringify(config) },
    runtime: { managedDirectory: directory }, fs: { filewatcher: false },
  }, { modules: [research, { id: "independent", open: () => ({ close: async () => {} }) }] }).pipe(Effect.provideService(Scope.Scope, scope)))
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => handler(request) })
  const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${server.port}`, headers: { "x-opencode-directory": encodeURIComponent(directory) } })
  await client.rpc(Capability.Api).list({}); await research.ready
  return { research, client, api: client.rpc(Capability.Api), async close() { await Effect.runPromise(Scope.close(scope, Exit.void)); server.stop(true) } }
}
type Host = Awaited<ReturnType<typeof boot>>
async function prompt(host: Host, sessionID: string, text: string) {
  const input = await host.client.session.prompt({ sessionID, text })
  await until(async () => (await host.client.experimental.session.input.output({ sessionID, inputID: input.id })).status === "closed")
  return input
}
function object(value: unknown): Record<string, unknown> { assert(value && typeof value === "object"); return value as Record<string, unknown> }
let host: Host | undefined, mcpServer: ReturnType<typeof Bun.serve> | undefined, mcp: Client | undefined
try {
  host = await boot()
  const a = await host.client.session.create({ title: "Any AI assistance A", location: { directory } })
  const b = await host.client.session.create({ title: "Replacement assistance B", location: { directory } })
  const runner = await host.client.session.create({ title: "Existing AI runner", location: { directory } })
  await prompt(host, a.id, "ADOPT_FIRST")
  const identity = object(await host.research.call({ backendID: "opencode", threadID: a.id }, "identity", {}))
  assert.deepEqual(object(identity.role).holder, { backendID: "opencode", threadID: a.id })
  assert(modelRequests[0]!.tools?.every((value) => value.function.name.startsWith("research_")))
  assert.equal(modelRequests[0]!.tools?.length, 10)
  checks.push("an ordinary native AI conversation adopts the role through trusted business tools while general tools remain absent")

  const restricted = await host.client.session.create({ title: "Chat-only permission boundary", location: { directory },
    permissions: [{ action: "*", resource: "*", effect: "deny" }] })
  await prompt(host, restricted.id, "CHAT_ONLY_POLICY")
  assert.equal(modelRequests.at(-1)!.tools?.length ?? 0, 0)
  checks.push("a deny-all native conversation such as the isolated QQ companion gains no research tools even while the module is active")

  await prompt(host, a.id, "BUILD_COMPLETE_PATH")
  const catalog = object(await host.research.call({ backendID: "opencode", threadID: a.id }, "paths", {}))
  assert.equal((catalog.published as unknown[]).length, 1); assert.equal(sourceRequests, 2)
  checks.push("the native AI probes real HTTP, authors a confined function, tests the saved revision and publishes its sourced result")

  await prompt(host, b.id, "ADOPT_SECOND")
  await prompt(host, b.id, "READ_SHARED_PATHS")
  await prompt(host, a.id, "STALE_EDIT")
  const shared = object(await host.research.call({ backendID: "opencode", threadID: b.id }, "paths", {}))
  assert.equal((shared.drafts as unknown[]).length, 1)
  assert.deepEqual(object(shared.role).holder, { backendID: "opencode", threadID: b.id })
  checks.push("a second native conversation takes over shared knowledge and the previous holder cannot save another revision")

  await prompt(host, runner.id, "RUN_PUBLISHED_PATH")
  assert.equal(sourceRequests, 3)
  assert.equal((await host.research.history())[0]!.score, 1.2)
  checks.push("a separate existing AI runner uses only the published function and updates its normal historical score")

  const principal: Identity = { backendID: "opencode", threadID: b.id }
  const endpoint = host.research.mcp(async (token) => token === "synthetic-role-token" ? principal : undefined)
  mcpServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: endpoint })
  const url = `http://127.0.0.1:${mcpServer.port}/mcp`
  mcp = new Client({ name: "external-ai-host-fixture", version: "1.0.0" })
  await mcp.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: "Bearer synthetic-role-token" } } }))
  assert.equal((await mcp.listTools()).tools.length, 10)
  const resources = await mcp.listResources(); assert.equal(resources.resources.length, 2)
  const read = await mcp.readResource({ uri: "research://paths" }); assert.equal(read.contents.length, 1)
  const published = await mcp.callTool({ name: "research_paths", arguments: {} })
  assert(!published.isError)
  checks.push("the official MCP client negotiates HTTP and reads the same tools, identity and path resources as native AI conversations")

  const denied = await mcp.callTool({ name: "research_publish", arguments: { pathID: definition.id, revision: "not-tested", testID: "fake" } })
  assert(denied.isError)
  const hint = await mcp.callTool({ name: "research_candidate", arguments: { id: "alternate", pathID: definition.id, at: "detail source", direction: "Observed alternative source",
    evidence: "Synthetic page links another direction", expectedInput: "movie identity", expectedOutput: "details" } })
  assert(!hint.isError)
  assert.equal((await host.research.history()).length, 1)
  checks.push("MCP uses identical publication checks and candidate hints never become executable or acquire scores")

  assert.equal((await fetch(url)).status, 401)
  assert.equal((await fetch(url, { method: "POST", headers: { authorization: "Bearer synthetic-role-token", origin: "https://untrusted.invalid" } })).status, 403)
  checks.push("the local MCP endpoint rejects unauthenticated callers and foreign browser origins without changing role ownership")

  const held = await host.client.session.prompt({ sessionID: b.id, text: "HOLD_IDENTITY" })
  await entered.promise
  const helper = { backendID: "opencode", threadID: runner.id }
  const help = { requestID: "blocked-source", goal: "Collect another source", issue: "Need a verified branch", evidence: { pathID: definition.id } }
  const admitted = await host.research.call(helper, "help", help)
  assert.equal(object(object(admitted).admission).status, "accepted")
  const queue = await host.client.session.inbox.list({ sessionID: b.id })
  assert.equal(queue.length, 1)
  await host.research.call(helper, "help", help)
  assert.equal((await host.client.session.inbox.list({ sessionID: b.id })).length, 1)
  assert.equal((await host.client.session.inbox.list({ sessionID: a.id })).length, 0)
  release.resolve()
  await until(async () => (await host!.client.experimental.session.input.output({ sessionID: b.id, inputID: held.id })).status === "closed")
  await until(async () => (await host!.client.session.inbox.list({ sessionID: b.id })).length === 0)
  checks.push("assistance requests enter only the current holder's original native Inbox and duplicate requests do not create more tasks")

  await mcp.close(); mcp = undefined; mcpServer.stop(true); mcpServer = undefined
  const beforeRestart = sourceRequests
  await host.close(); host = await boot()
  const restored = object(await host.research.call(principal, "paths", {}))
  assert.deepEqual(object(restored.role).holder, principal)
  assert.equal((restored.published as unknown[]).length, 1)
  assert.equal(sourceRequests, beforeRestart)
  checks.push("SQLite restart retains the movable role, authored paths, tests and shared knowledge without re-exploring or re-running sources")

  await host.api.stop({ id: "research" })
  assert.equal((await host.api.list({})).find((value) => value.id === "independent")?.state, "active")
  await prompt(host, runner.id, "ORDINARY_AI_AFTER_RESEARCH_STOP")
  assert.equal(modelRequests.at(-1)!.tools?.length ?? 0, 0)
  checks.push("stopping research removes its native model tools and preserves ordinary conversations and unrelated modules")
  console.log(JSON.stringify({ status: "passed", checks, source_requests: sourceRequests, model_requests: modelRequests.length,
    role_is_model_bound: false, official_mcp_client: true, actual_websites: false, actual_qq_connection: false,
    private_data_migrated: false, production_switch: false }))
} finally { release.resolve(); await mcp?.close(); mcpServer?.stop(true); await host?.close(); upstream.stop(true); source.stop(true) }
