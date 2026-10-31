// Isolated verification tool, not an application entry or a second task scheduler.
import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import path from "node:path"
import { Context, Effect, Layer, Logger, Schema } from "effect"
import { HttpEffect, HttpRouter, HttpServer } from "effect/http"
import { Database } from "@opencode/core/database/database"
import { SessionTable, SessionInboxTable } from "@opencode/core/session/sql"
import { ConversationBackend } from "@opencode/core/conversation-backend"
import { Admission, type Ref } from "@opencode/schema/conversation-backend"
import { createEmbeddedRoutes } from "../src/routes"
import { CodexSessionAdapter, createSharedProfile, nativeBackend, stopSharedService } from "../../../../modules/codex-native/src"

const executable = process.env.IM_CODEX_EXECUTABLE
const root = process.env.IM_CODEX_TEST_ROOT
if (!executable || !root) throw new Error("Use python -m tools.codex_native_smoke")
const checks: string[] = []
const requests: unknown[] = []
const entered = Promise.withResolvers<void>()
const release = Promise.withResolvers<void>()
const finished = Promise.withResolvers<void>()
const upstream = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    if (request.method !== "POST") return Response.json({ data: [] })
    requests.push(await request.json())
    const serial = requests.length
    if (serial === 1) { entered.resolve(); await release.promise }
    const item = { id: `msg_host_${serial}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: `host-reply-${serial}`, annotations: [] }] }
    const events = [
      { type: "response.created", response: { id: `resp_host_${serial}`, status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: `resp_host_${serial}`, status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 } } },
    ]
    return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
  },
})
const home = await mkdtemp(path.join(root, "host-"))
const profile = await createSharedProfile(path.join(home, "codex"), { id: "fixture", model: "local-fixture", baseURL: `http://127.0.0.1:${upstream.port}/v1`, keyName: "IM_FIXTURE_KEY" })
const adapter = await CodexSessionAdapter.open({ executable, profile, apiKey: "fixture-only" })
let completions = 0
let activeTurnID: string | undefined
adapter.subscribe((event) => {
  if (event.method === "turn/started") activeTurnID = (event.params.turn as { id: string }).id
  if (event.method === "turn/completed" && ++completions === 3) finished.resolve()
})
let ref: Ref
let receipt: unknown

async function round(resume: boolean) {
  await Effect.runPromise(Effect.gen(function* () {
    const context = yield* Layer.build(createEmbeddedRoutes({
      database: { path: path.join(home, "application.sqlite") }, models: { fetch: false },
      runtime: { managedDirectory: profile.workspace },
      config: { directory: path.join(home, "config"), project: false, claude: false, content: "{}" },
      fs: { filewatcher: false },
    }).pipe(Layer.provide(HttpServer.layerServices)))
    const handler = Context.get(context, HttpRouter.HttpRouter).asHttpEffect().pipe(HttpEffect.toWebHandlerWith(context))
    const call = async (method: string, input: unknown) => {
      const url = new URL(`/api/rpc/experimental.conversation/${method}`, "http://assistant.local")
      url.searchParams.set("location[directory]", profile.workspace)
      const response = await handler(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input }) }))
      const body = await response.json() as { output: unknown }
      assert.equal(response.status, 200, `Native application RPC ${method} failed: ${JSON.stringify(body)}`)
      return body.output
    }
    // Managed mode still denies arbitrary SDK plugins. The trusted embedder registers
    // this complete backend through the public host service, not a config/plugin escape.
    const host = Context.get(context, ConversationBackend.Service)
    const backend = nativeBackend(adapter)
    yield* host.register({
      ...backend,
      enqueue: async (input) => {
        const accepted = await backend.enqueue(input)
        if (input.inputID === "host-lost-ack") throw new Error("Fixture lost native acknowledgment")
        return accepted
      },
    })
    assert.deepEqual(yield* Effect.promise(() => call("list", {})), [{ id: "codex-native", label: "Codex" }])
    assert.deepEqual(yield* Effect.promise(() => call("status", { backendID: "codex-native" })), { authentication: { state: "not-required" } })
    assert.equal(yield* Effect.promise(() => call("cancelLogin", { backendID: "codex-native", loginID: "00000000-0000-0000-0000-000000000001" })), "not-found")
    if (!resume) checks.push("native account projection and scoped login cancellation use the real application RPC")
    if (resume) {
      const retried = yield* Effect.promise(() => call("send", { ref, inputID: "host-pending", text: "native-pending" }))
      assert.deepEqual(retried, receipt)
      assert.equal(requests.length, 4)
      checks.push("application SQLite restart returns the same receipt without native re-admission")
      const disconnected = Promise.withResolvers<void>()
      const unsubscribe = adapter.onClose(() => disconnected.resolve())
      yield* Effect.promise(() => stopSharedService({ executable: executable!, profile, apiKey: "fixture-only" }))
      yield* Effect.promise(() => disconnected.promise)
      unsubscribe()
      assert.deepEqual(yield* Effect.promise(() => call("list", {})), [])
      checks.push("native disconnection unregisters the backend from the real application RPC")
      return
    }
    const created = Schema.decodeUnknownSync(Schema.Struct({ thread: Schema.Struct({ id: Schema.String }) }))(
      yield* Effect.promise(() => call("create", { backendID: "codex-native" })),
    )
    ref = { backendID: "codex-native", threadID: created.thread.id }
    const sent = Schema.decodeUnknownSync(Admission)(yield* Effect.promise(() => call("send", { ref, inputID: "host-active", text: "native-active" })))
    assert.equal(sent.status, "accepted")
    yield* Effect.promise(() => entered.promise)
    assert(activeTurnID)
    const adjustment = { ref, inputID: "host-steer", text: "native-adjustment", delivery: "steer", expectedTurnID: activeTurnID }
    const steered = Schema.decodeUnknownSync(Admission)(yield* Effect.promise(() => call("send", adjustment)))
    assert.equal(steered.status, "accepted")
    if (steered.status === "accepted") assert.equal(steered.receipt.kind, "steered")
    assert.deepEqual(yield* Effect.promise(() => call("send", adjustment)), steered)
    checks.push("steering uses the same admission ID and the native active-turn guard")
    const duplicated = yield* Effect.promise(() => Promise.all(Array.from({ length: 8 }, () => call("send", { ref, inputID: "host-pending", text: "native-pending" }))))
    assert(duplicated.some((value) => Schema.decodeUnknownSync(Admission)(value).status === "accepted"))
    receipt = yield* Effect.promise(() => call("send", { ref, inputID: "host-pending", text: "native-pending" }))
    assert.equal(Schema.decodeUnknownSync(Admission)(receipt).status, "accepted")
    const queued = yield* Effect.promise(() => adapter.queue(ref.threadID))
    assert.equal(queued.data.filter((entry) => entry.clientUserMessageId === "host-pending").length, 1)
    checks.push("eight concurrent HTTP copies create exactly one native queued submission")
    const lost = yield* Effect.promise(() => call("send", { ref, inputID: "host-lost-ack", text: "native-lost-ack" }))
    assert.equal(Schema.decodeUnknownSync(Admission)(lost).status, "uncertain")
    const recovered = yield* Effect.promise(() => call("send", { ref, inputID: "host-lost-ack", text: "native-lost-ack" }))
    assert.equal(Schema.decodeUnknownSync(Admission)(recovered).status, "accepted")
    assert.equal((yield* Effect.promise(() => adapter.queue(ref.threadID))).data.length, 2)
    checks.push("unknown native acknowledgment reconciles the real queue instead of re-sending")
    const db = Context.get(context, Database.Service).db
    // Query the real database, never a mirrored Codex session or queue.
    assert.equal((yield* db.select({ id: SessionTable.id }).from(SessionTable).all()).length, 0)
    assert.equal((yield* db.select({ id: SessionInboxTable.id }).from(SessionInboxTable).all()).length, 0)
    checks.push("Codex inputs create no OpenCode Session or Inbox rows")
  }).pipe(Effect.scoped, Effect.provide(Logger.layer([]))))
}

try {
  await round(false)
  release.resolve()
  const deadline = setTimeout(() => finished.reject(new Error("Native completion deadline")), 30000)
  try { await finished.promise } finally { clearTimeout(deadline) }
  assert.equal(requests.length, 4)
  const native = nativeBackend(adapter)
  const recovered = await native.reconcile(ref!, "host-lost-ack")
  assert.equal(recovered?.kind, "message")
  checks.push("after queue consumption, native clientId resolves to the persisted user message")
  await round(true)
  console.log(JSON.stringify({ status: "passed", checks, model_requests: requests.length, production_credentials_used: false }))
} finally {
  release.resolve()
  await adapter.close()
  await stopSharedService({ executable, profile, apiKey: "fixture-only" })
  upstream.stop(true)
}
