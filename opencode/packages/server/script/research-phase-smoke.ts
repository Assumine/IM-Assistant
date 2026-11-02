// Actual product process, native AI tools/SQLite, authenticated MCP and controlled HTTP sources.
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { OpenCode } from "@opencode/client"
import { Capability } from "@opencode/schema/capability"
import type { Draft } from "../../../../modules/research/src/index"
import { Client, StreamableHTTPClientTransport } from "../../../../modules/research/test/mcp-client"

const root = process.env.IM_RESEARCH_PHASE_TEST_ROOT
if (!root) throw new Error("Use the isolated research product runner")
const home = await mkdtemp(path.join(root, "research-product-")), entry = path.resolve(import.meta.dirname, "../../im-assistant/src/cli.ts")
const checks: string[] = [], reads: string[] = [], models: unknown[] = [], clients: Client[] = []
const backup = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }
const final = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }
const long = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }
let seeding = true
const primary = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
  reads.push("primary")
  return seeding ? Response.json({ title: "Fixture comedy", source: "primary" }) : new Response("Safe source failure", { status: 503 })
} })
const secondary = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  reads.push("backup")
  const title = new URL(request.url).searchParams.get("title")
  if (title === "Access") return new Response("Manual access needed", { status: 403 })
  if (title === "Long") { long.entered.resolve(); await long.release.promise }
  if (!seeding && title === "Fixture comedy") { backup.entered.resolve(); await backup.release.promise }
  return Response.json({ title: title ?? "Fixture comedy", source: "backup" })
} })
const args = (title = "Fixture comedy", roundID = "product-call") => ({ category: "film", action: "details", input: { title }, roundID })
const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (request.method !== "POST") return Response.json({ data: [] })
  const body = await request.json() as { messages: { role: string; content: unknown }[] }
  models.push(body)
  const boundary = body.messages.findLastIndex((value) => value.role === "user"), text = JSON.stringify(body.messages[boundary]?.content)
  const replies = body.messages.slice(boundary + 1).filter((value) => value.role === "tool")
  const title = text.includes("S3_ACCESS") ? "Access" : text.includes("S3_LONG") ? "Long" : "Fixture comedy"
  const run = /S3_(RUN|ACCESS|LONG)/.test(text)
  const next = run && replies.length === 0
  if (text.includes("S3_RUN") && replies.length) { final.entered.resolve(); await final.release.promise }
  const delta = next ? { role: "assistant", tool_calls: [{ index: 0, id: "call_product_" + models.length, type: "function",
    function: { name: "research_run", arguments: JSON.stringify(args(title)) } }] } : { role: "assistant", content: "PRODUCT_RESEARCH_DONE" }
  return new Response([
    { choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: next ? "tool_calls" : "stop" }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } },
  ].map((chunk) => "data: " + JSON.stringify(chunk) + "\n\n").join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
} })
const tokens = { IM_RESEARCH_MCP_TOKEN_OWNER: "synthetic-product-owner-token-123456", IM_RESEARCH_MCP_TOKEN_RUNNER: "synthetic-product-runner-token-123456",
  IM_RESEARCH_MCP_TOKEN_UNBOUND: "synthetic-product-unbound-token-123456" }
const environment = () => ({ ...process.env, ...tokens, IM_ASSISTANT_DATA_ROOT: home, OPENCODE_DISABLE_MODELS_FETCH: "true" })
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 30000
  while (!await check()) { if (Date.now() >= deadline) throw new Error("Research product condition deadline"); await Bun.sleep(5) }
}
async function command(args: string[], success = true) {
  const child = Bun.spawn([process.execPath, "run", entry, ...args], { env: environment(), stdout: "pipe", stderr: "pipe", windowsHide: true })
  const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  assert.equal(code === 0, success, error)
  for (const token of Object.values(tokens)) assert(!output.includes(token) && !error.includes(token))
  return success ? JSON.parse(output) as { enabled: boolean; tasksStarted: boolean } : undefined
}
async function boot() {
  const child = Bun.spawn([process.execPath, "run", entry, "serve", "--hostname", "127.0.0.1", "--port", "0"],
    { env: environment(), stdout: "pipe", stderr: "pipe", windowsHide: true })
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
    for (const token of Object.values(tokens)) assert(!error.includes(token))
  }
  const timeout = setTimeout(() => ready.reject(new Error("Product boot deadline")), 30000)
  try { await ready.promise } catch (error) { await stop(); throw error } finally { clearTimeout(timeout) }
  assert(url && password)
  const client = OpenCode.make({ baseUrl: url, headers: { authorization: "Basic " + Buffer.from("opencode:" + password).toString("base64"),
    "x-opencode-directory": encodeURIComponent(path.join(home, "session-location")) } })
  return { client, api: client.rpc(Capability.Api), stop }
}
let host: Awaited<ReturnType<typeof boot>> | undefined
const state = async () => (await host!.api.list({})).find((item) => item.id === "research")
const view = () => host!.api.view({ id: "research", locale: "en" })
const record = (value: unknown): Record<string, unknown> => { assert(value && typeof value === "object"); return value as Record<string, unknown> }
async function endpoint() {
  let url: string | undefined
  await until(async () => { url = /MCP: (http:\/\/127\.0\.0\.1:\d+\/mcp)/.exec((await view()).document?.description ?? "")?.[1]; return !!url })
  assert(url); return url
}
async function mcp(url: string, token: string) {
  const client = new Client({ name: "product-acceptance", version: "1" }); clients.push(client)
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: "Bearer " + token } } }))
  return client
}
async function call(client: Client, name: string, input: Record<string, unknown> = {}, error = false) {
  const result = await client.callTool({ name: "research_" + name, arguments: input })
  assert.equal(result.isError === true, error, JSON.stringify(result))
  const text = (result.content as { type: string; text?: string }[]).find((part) => part.type === "text")?.text
  assert(text); return record(JSON.parse(text))
}
async function closeClients() { await Promise.all(clients.splice(0).map((client) => client.close())) }
try {
  assert.equal((await command(["research", "status"]))?.enabled, false)
  await command(["research", "init"]); await command(["research", "init"], false)
  await command(["research", "configure", "relative.json"], false)
  const native = path.join(home, "native/config/opencode/opencode.json")
  await writeFile(native, JSON.stringify({ update: "disable", share: "disabled", model: "fixture/fixture",
    agents: { build: { permissions: [{ action: "*", resource: "*", effect: "deny" }, { action: "research_*", resource: "*", effect: "allow" }] } },
    providers: { fixture: { name: "Controlled model", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "synthetic" },
      models: { fixture: { name: "Fixture", limit: { context: 32000, output: 2048 }, capabilities: { tools: true, input: ["text"], output: ["text"] } } } } } }))
  host = await boot()
  await until(async () => (await host!.api.list({})).every((item) => item.state === "disabled"))
  assert.equal((await host.api.list({})).length, 3); assert.equal(reads.length + models.length, 0)
  const helper = await host.client.session.create({ title: "Research owner", location: { directory: path.join(home, "session-location") } })
  const runner = await host.client.session.create({ title: "Film research", location: { directory: path.join(home, "session-location") } })
  const inputID = "msg_researchproduct01"
  checks.push("the actual product CLI defaults research and both QQ modules off; settings and native sessions work without QQ or source/model traffic")

  const initial = await host.api.settings({ id: "research" })
  const desired = { version: 1, enabled: true, sources: [{ id: "primary", origin: `http://127.0.0.1:${primary.port}` }, { id: "backup", origin: `http://127.0.0.1:${secondary.port}` }],
    mcp: { enabled: true, port: 0, clients: [
      { tokenEnv: "IM_RESEARCH_MCP_TOKEN_OWNER", backendID: "opencode", threadID: helper.id },
      { tokenEnv: "IM_RESEARCH_MCP_TOKEN_RUNNER", backendID: "opencode", threadID: runner.id, inputID },
      { tokenEnv: "IM_RESEARCH_MCP_TOKEN_UNBOUND", backendID: "opencode", threadID: runner.id },
    ] } }
  const file = path.join(home, "desired-research.json"); await writeFile(file, JSON.stringify(desired))
  assert.equal((await command(["research", "configure", file]))?.tasksStarted, false)
  await assert.rejects(host.api.configure({ id: "research", revision: initial.revision, text: initial.text }))
  await assert.rejects(host.api.configure({ id: "research", revision: (await host.api.settings({ id: "research" })).revision, text: JSON.stringify({ ...desired, token: "synthetic-private-secret" }) }),
    (error) => !JSON.stringify(error).includes("synthetic-private-secret"))
  assert.equal((await state())?.state, "disabled")
  checks.push("declarative CLI/native settings really persist, fence stale writers and hide raw secrets; desired configuration does not pretend a stopped service has started")
  await host.stop(); host = await boot()
  await until(async () => (await state())?.health?.phase === "ready")
  const url = await endpoint()
  assert.equal((await fetch(url)).status, 401)
  assert.equal((await fetch(url, { headers: { origin: "https://untrusted.test", authorization: "Bearer " + tokens.IM_RESEARCH_MCP_TOKEN_OWNER } })).status, 403)
  const owner = await mcp(url, tokens.IM_RESEARCH_MCP_TOKEN_OWNER), external = await mcp(url, tokens.IM_RESEARCH_MCP_TOKEN_RUNNER), unbound = await mcp(url, tokens.IM_RESEARCH_MCP_TOKEN_UNBOUND)
  assert.equal((await owner.listTools()).tools.length, 11)
  assert.equal(reads.length + models.length, 0); assert.equal((await view()).document?.items.length, 0)
  checks.push("configured MCP binds only loopback, authenticates host-assigned conversation identities and refuses foreign origins; opening its read-only view starts no research")
  await call(owner, "adopt", { expectedVersion: 0 })
  for (const id of ["primary", "backup"]) {
    const pathID = id === "primary" ? "a-primary" : "b-backup"
    const definition: Draft = { id: pathID, revision: "1", category: "film", action: "details", title: id === "primary" ? "Primary movie details" : "Backup movie details",
      tools: ["read_json"], inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
      outputSchema: { type: "object", properties: { title: { type: "string" }, source: { type: "string" } }, required: ["title", "source"] },
      program: `return await tools.read_json({source:${JSON.stringify(id)},path:"/details?title="+encodeURIComponent(input.title)})` }
    await call(owner, "save", { definition }); await call(owner, "test", { testID: "test-" + id, pathID, revision: "1", input: { title: "Seed" } })
    await call(owner, "publish", { pathID, revision: "1", testID: "test-" + id })
  }
  assert.deepEqual(reads, ["primary", "backup"])
  checks.push("a real transferable role authors, actually tests with approved HTTP I/O and publishes two interchangeable functions through the official MCP client")
  seeding = false
  const work = await host.client.session.prompt({ sessionID: runner.id, id: inputID, text: "Find a comedy for tonight\nS3_RUN" })
  assert.equal(work.id, inputID)
  await backup.entered.promise
  const live = await view(), item = live.document?.items.find((row) => row.id === inputID)
  assert(item); assert.equal(item.title, "Find a comedy for tonight"); assert.equal(item.state, "running")
  assert.equal(item.fields.find((field) => field.label === "Current action")?.value, "Backup movie details")
  assert.equal(record(JSON.parse(item.technical!)).owner && record(record(JSON.parse(item.technical!)).owner).inputID, inputID)
  const before = reads.length; await view(); await view(); assert.equal(reads.length, before)
  checks.push("native AI tools use the original input, penalize the failing primary and select the backup; live presentation shows the actual goal/function without performing I/O")
  await call(unbound, "run", args(), true)
  backup.release.resolve(); await final.entered.promise
  assert.equal((await call(external, "run", args("Fixture comedy", "different-label"))).reused, true)
  assert.equal(reads.length, before)
  checks.push("native execution and authenticated MCP share the same checkpoint; unbound execution is rejected and changing the call label cannot restart collection")
  final.release.resolve()
  await until(async () => (await host!.client.session.input.position({ sessionID: runner.id, inputID })).status === "closed")
  const ended = (await view()).document!.items.find((row) => row.id === inputID)!
  assert.equal(ended.state, "success")
  const scores = ended.fields.find((field) => field.label === "Path selection")!.value
  assert(scores.includes("Primary movie details: history 1.00 / round -1.00"), scores); assert(scores.includes("Backup movie details: history 1.00 / round 1.20"), scores)
  checks.push("native completion finalizes one persisted round with distinct historic and current scores; progress remains a readable saved result")
  const access = await host.client.session.prompt({ sessionID: runner.id, text: "Check an access-limited source\nS3_ACCESS" })
  await until(async () => (await host!.client.session.input.position({ sessionID: runner.id, inputID: access.id })).status === "closed")
  const blocked = (await view()).document!.items.find((row) => row.id === access.id)!
  assert.equal(blocked.state, "attention"); assert(blocked.fields.some((field) => field.value.includes("needs access")))
  assert.equal(reads.filter((id) => id === "backup").length, 3)
  const requests = (await call(owner, "paths")).requests as unknown[]
  assert.equal(requests.length, 1)
  checks.push("an access gate stops after one attempt and leaves the concrete blocker visible; assistance enters the existing native Inbox exactly once")
  const helpInput = record(record(requests[0]).admission).inputID
  assert.equal(typeof helpInput, "string")
  await until(async () => (await host!.client.session.input.position({ sessionID: helper.id, inputID: helpInput as string })).status === "closed")
  const counts = [reads.length, models.length]
  await closeClients(); await host.stop(); host = await boot(); const restoredURL = await endpoint()
  const restored = await mcp(restoredURL, tokens.IM_RESEARCH_MCP_TOKEN_RUNNER)
  assert.equal((await call(restored, "run", args())).reused, true)
  assert.equal((await call(restored, "run", args("Another target", "another-target"))).reason, "native-input-not-open")
  assert.deepEqual([reads.length, models.length], counts)
  assert((await view()).document!.items.some((row) => row.id === access.id && row.state === "attention"))
  checks.push("real product restart restores SQLite identities, checkpoints and blockers without replaying work or starting idle research")
  await host.client.session.prompt({ sessionID: runner.id, text: "Check cancellable collection\nS3_LONG" }); await long.entered.promise
  await host.api.stop({ id: "research" })
  assert.equal((await state())?.state, "stopped"); assert.equal((await view()).status, "unavailable")
  await assert.rejects(fetch(restoredURL))
  assert.equal((await host.api.list({})).filter((item) => item.id.startsWith("qq-")).every((item) => item.state === "disabled"), true)
  long.release.resolve()
  checks.push("stopping research aborts its active collector, removes tools and local MCP while leaving QQ and the native application lifecycle independent")
  await command(["research", "disable"]); await closeClients(); await host.stop(); host = await boot()
  await until(async () => (await state())?.state === "disabled")
  const stoppedCounts = [reads.length, models.length]; await view(); assert.deepEqual([reads.length, models.length], stoppedCounts)
  checks.push("persisted disable applies at the next service start and no previous task is resumed or recopied")
  await host.stop(); await writeFile(path.join(home, "modules/research/research.json"), '{"private":"synthetic-private-secret"')
  host = await boot(); await until(async () => (await state())?.state === "failed")
  const ordinary = await host.client.session.create({ title: "Unaffected desktop", location: { directory: path.join(home, "session-location") } })
  const ordinaryInput = await host.client.session.prompt({ sessionID: ordinary.id, text: "Ordinary native message" })
  await until(async () => (await host!.client.session.input.position({ sessionID: ordinary.id, inputID: ordinaryInput.id })).status === "closed")
  await assert.rejects(host.api.settings({ id: "research" }), (error) => !JSON.stringify(error).includes("synthetic-private-secret"))
  assert(!(await readFile(native, "utf8")).includes(tokens.IM_RESEARCH_MCP_TOKEN_OWNER))
  checks.push("malformed research settings fail only that optional module and never leak private fields; ordinary native AI and SQLite remain usable")
  console.log(JSON.stringify({ status: "passed", checks, source_requests: reads.length, model_requests: models.length,
    product_entry: "packages/im-assistant/src/cli.ts", official_mcp_client: true, actual_qq_connection: false, actual_websites: false, private_data_migrated: false, production_switch: false }))
} catch (error) { console.error(JSON.stringify({ completed_checks: checks.length, last_check: checks.at(-1), source_requests: reads.length, model_requests: models.length })); throw error }
finally { backup.release.resolve(); final.release.resolve(); long.release.resolve(); await closeClients(); await host?.stop(); primary.stop(true); secondary.stop(true); model.stop(true) }
