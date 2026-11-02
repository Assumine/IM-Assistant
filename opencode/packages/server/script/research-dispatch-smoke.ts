// Native Scope/SQLite/HTTP acceptance. All collector data is synthetic loopback content.
import assert from "node:assert/strict"
import { mkdtemp, mkdir } from "node:fs/promises"
import path from "node:path"
import { Effect, Exit, Scope } from "effect"
import { OpenCode } from "@opencode/client"
import type { ApplicationModule } from "@opencode/plugin/promise/application"
import { Capability } from "@opencode/schema/capability"
import { ServerFetch } from "../src/fetch"
import { createResearchModule, type Data, type ResearchPath } from "../../../../modules/research/src/index"

const root = process.env.IM_RESEARCH_TEST_ROOT
if (!root) throw new Error("Use the isolated research acceptance runner")
const home = await mkdtemp(path.join(root, "research-")), directory = path.join(home, "location")
await mkdir(directory); await mkdir(path.join(home, "config"))
const checks: string[] = [], calls: string[] = []
const slow = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
const source = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    calls.push(url.pathname)
    if (url.pathname === "/unavailable") return new Response("Collector service failed", { status: 502 })
    if (url.pathname === "/login") return new Response("Manual login required", { status: 403 })
    if (url.pathname === "/slow") { slow.resolve(); await release.promise }
    return Response.json({ title: url.searchParams.get("query"), source: "loopback fixture" })
  },
})
const object = (value: Data): value is { readonly [key: string]: Data } => value !== null && typeof value === "object" && !Array.isArray(value)
function collector(id: string, endpoint: string, action = "lookup"): ResearchPath {
  return {
    id, revision: "1", category: "film", action, title: id,
    accepts: (value) => object(value) && typeof value.query === "string",
    validates: (value) => object(value) && typeof value.title === "string",
    async run(input, { signal }) {
      assert(object(input))
      const response = await fetch(`http://127.0.0.1:${source.port}/${endpoint}?query=${encodeURIComponent(String(input.query))}`, { signal })
      if (response.status === 502) return { status: "failure", reason: "read-only collector service failed; safe to retry" }
      if (response.status === 403) return { status: "blocked", reason: "manual-login-required: retain current page" }
      if (!response.ok) return { status: "uncertain", reason: "upstream response needs review" }
      return { status: "success", value: await response.json() as Data }
    },
  }
}
const request = (roundID: string, action = "lookup") => ({ roundID, category: "film", action, input: { query: "Synthetic movie" } })
type Context = Parameters<ApplicationModule["open"]>[0]
async function boot(broken = false) {
  const research = createResearchModule({ paths: [collector("a-primary", "unavailable"), collector("b-backup", "resource"),
    collector("login", "login", "login"), collector("slow", "slow", "slow")], ...(broken ? { scoring: { failurePenalty: 0 } } : {}) })
  let context: Context | undefined, observer: Context | undefined
  const modules: ApplicationModule[] = [
    { ...research, open(value) { context = value; return research.open(value) } },
    { id: "independent-observer", open(value) { observer = value; return { close: async () => {} } } },
  ]
  const scope = Effect.runSync(Scope.make())
  let server: ReturnType<typeof Bun.serve> | undefined
  try {
    const handler = await Effect.runPromise(ServerFetch.make({
      database: { path: path.join(home, "native.sqlite") }, models: { fetch: false },
      config: { directory: path.join(home, "config"), project: false, claude: false,
        content: JSON.stringify({ update: "disable", share: "disabled" }) },
      runtime: { managedDirectory: directory }, fs: { filewatcher: false },
    }, { modules }).pipe(Effect.provideService(Scope.Scope, scope)))
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (value) => handler(value) })
    const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${server.port}`, headers: { "x-opencode-directory": encodeURIComponent(directory) } })
    const api = client.rpc(Capability.Api)
    const statuses = await api.list({})
    assert.equal(statuses.find((value) => value.id === "research")?.state, broken ? "failed" : "active")
    assert(context && observer)
    if (!broken) await research.ready
    return { research, client, api, context, observer,
      async close() { await Effect.runPromise(Scope.close(scope, Exit.void)); server!.stop(true) } }
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.void)); server?.stop(true); throw error
  }
}
type Host = Awaited<ReturnType<typeof boot>>
let host: Host | undefined
try {
  host = await boot()
  assert(!(await host.api.list({})).some((value) => value.id.startsWith("qq")))
  const session = await host.client.session.create({ title: "Ordinary native work", location: { directory } })
  await host.client.session.prompt({ sessionID: session.id, text: "Admit native work without starting a model", resume: false })
  const queued = await host.client.session.inbox.list({ sessionID: session.id })
  assert.equal(queued.length, 1)
  checks.push("optional research starts without QQ while ordinary native Session/Inbox admit work unchanged")

  const first = await host.research.run(request("fallback"))
  assert.equal(first.status, "success")
  assert.deepEqual(first.attempts.map((value) => value.pathID), ["a-primary", "b-backup"])
  assert.deepEqual(calls, ["/unavailable", "/resource"])
  assert.deepEqual(first.output, { title: "Synthetic movie", source: "loopback fixture" })
  checks.push("real read-only HTTP collectors re-rank a failed primary and validate the backup result before delivery")

  const history = await host.research.history()
  assert.equal(history.find((value) => value.id === "a-primary")?.score, 0.9)
  assert.equal(history.find((value) => value.id === "b-backup")?.score, 1.2)
  assert.equal((await host.context.storage.scan({ prefix: "round/result/" })).entries.length, 1)
  assert.equal((await host.observer.storage.scan({ prefix: "round/result/" })).entries.length, 0)
  await host.observer.storage.set("round/result/private", { private: "observer only" })
  assert.deepEqual(await host.research.history(), history)
  checks.push("one native KV receipt holds one historical update per path and another module cannot see or corrupt it")

  const same = await Promise.all([host.research.run(request("concurrent")), host.research.run(request("concurrent"))])
  assert.deepEqual(same[0], same[1]); assert.equal(calls.length, 3)
  assert.equal(same[0]!.attempts[0]!.pathID, "b-backup")
  checks.push("concurrent duplicates execute once and the historically successful path is preferred next round")

  await assert.rejects(host.research.run({ ...request("fallback"), input: { query: "Different requirement" } }), /conflict/)
  assert.equal(calls.length, 3)
  checks.push("reusing a completed round ID for another requirement rejects before external I/O")

  const blocked = await host.research.run(request("login", "login"))
  assert.equal(blocked.status, "blocked"); assert.equal(blocked.attempts.length, 1)
  assert(blocked.reason?.includes("retain current page"))
  assert.equal((await host.research.history()).find((value) => value.id === "login")?.rounds, 0)
  checks.push("a login barrier stops at the current operation and does not retry or punish path reliability")

  const beforeRestart = calls.length
  await host.close(); host = await boot()
  assert.deepEqual(await host.research.run(request("fallback")), first)
  assert.equal(calls.length, beforeRestart)
  assert.equal((await host.research.history()).find((value) => value.id === "b-backup")?.rounds, 2)
  assert.equal((await host.client.session.inbox.list({ sessionID: session.id })).length, 1)
  checks.push("real SQLite restart restores immutable receipts and history without replaying collectors or consuming native Inbox")

  await host.context.storage.insert("round/intent/interrupted", JSON.stringify({ action: "lookup", category: "film", input: { query: "Synthetic movie" } }))
  const interrupted = await host.research.run(request("interrupted"))
  assert.equal(interrupted.status, "uncertain"); assert.equal(interrupted.attempts.length, 0)
  assert.equal(calls.length, beforeRestart)
  checks.push("a persisted start without a result requires review rather than replaying an unknown external operation")

  const running = host.research.run(request("slow", "slow"))
  await slow.promise
  await host.api.stop({ id: "research" })
  assert.equal((await running).status, "cancelled")
  release.resolve()
  await assert.rejects(host.research.run(request("after-stop")), /not active/)
  assert.equal((await host.api.list({})).find((value) => value.id === "independent-observer")?.state, "active")
  assert.equal((await host.client.session.inbox.list({ sessionID: session.id })).length, 1)
  checks.push("native capability stop aborts active collector I/O while another module and native pending work remain available")

  await host.close(); host = await boot()
  const beforeCancelledReplay = calls.length
  assert.equal((await host.research.run(request("slow", "slow"))).status, "cancelled")
  assert.equal(calls.length, beforeCancelledReplay)
  checks.push("cancelled round receipts persist across a second native restart without starting the request again")

  await host.close(); host = await boot(true)
  assert((await host.client.session.create({ title: "Core survives invalid optional module", location: { directory } })).id)
  assert.equal((await host.api.list({})).find((value) => value.id === "independent-observer")?.state, "active")
  checks.push("invalid research configuration fails only its optional module and leaves core session creation operational")
  console.log(JSON.stringify({ status: "passed", checks, source_requests: calls.length, native_sqlite: true,
    actual_websites: false, model_requests: 0, actual_qq_connection: false, private_data_migrated: false, production_switch: false }))
} finally { release.resolve(); await host?.close(); source.stop(true) }
