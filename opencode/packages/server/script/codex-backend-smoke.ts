// Isolated verification tool, not an application entry or a second task scheduler.
import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import path from "node:path"
import { Context, Effect, Layer, Logger, Schema } from "effect"
import { HttpEffect, HttpRouter, HttpServer } from "effect/http"
import { Database } from "@opencode/core/database/database"
import { SessionTable, SessionInboxTable } from "@opencode/core/session/sql"
import { Admission, Created, Execution, type Ref } from "@opencode/schema/conversation-backend"
import { createEmbeddedRoutes } from "../src/routes"
import {
  CodexSessionAdapter,
  createSharedProfile,
  nativeBackend,
  nativeModule,
  stopSharedService,
} from "../../../../modules/codex-native/src"

const executable = process.env.IM_CODEX_EXECUTABLE
const root = process.env.IM_CODEX_TEST_ROOT
if (!executable || !root) throw new Error("Use python -m tools.codex_native_smoke")
const checks: string[] = []
const requests: unknown[] = []
const entered = Promise.withResolvers<void>()
const release = Promise.withResolvers<void>()
const finished = Promise.withResolvers<void>()
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method !== "POST") return Response.json({ data: [] })
    requests.push(await request.json())
    const serial = requests.length
    if (serial === 1) {
      entered.resolve()
      await release.promise
    }
    const item = {
      id: `msg_host_${serial}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: `host-reply-${serial}`, annotations: [] }],
    }
    const events = [
      { type: "response.created", response: { id: `resp_host_${serial}`, status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: {
          id: `resp_host_${serial}`,
          status: "completed",
          output: [item],
          usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 },
        },
      },
    ]
    return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    })
  },
})
const home = await mkdtemp(path.join(root, "host-"))
const profile = await createSharedProfile(path.join(home, "codex"), {
  id: "fixture",
  model: "local-fixture",
  baseURL: `http://127.0.0.1:${upstream.port}/v1`,
  keyName: "IM_FIXTURE_KEY",
})
const adapter = await CodexSessionAdapter.open({ executable, profile, apiKey: "fixture-only" })
let completions = 0
let activeTurnID: string | undefined
adapter.subscribe((event) => {
  if (event.method === "turn/completed" && ++completions === 3) finished.resolve()
})
let ref: Ref
let receipt: unknown

async function round(resume: boolean) {
  const registered = Promise.withResolvers<void>()
  const failed = Promise.withResolvers<void>()
  const pendingBoot = Promise.withResolvers<void>()
  const mismatch = Promise.withResolvers<void>()
  const detached = Promise.withResolvers<void>()
  const moduleDisconnected = Promise.withResolvers<void>()
  const module = nativeModule({ executable: executable!, profile, apiKey: "fixture-only" })
  let closes = 0
  await Effect.runPromise(
    Effect.gen(function* () {
      const context = yield* Layer.build(
        createEmbeddedRoutes(
          {
            database: { path: path.join(home, "application.sqlite") },
            models: { fetch: false },
            runtime: { managedDirectory: profile.workspace },
            config: { directory: path.join(home, "config"), project: false, claude: false, content: "{}" },
            fs: { filewatcher: false },
          },
          [],
          undefined,
          [
            {
              id: "fixture-failed",
              open: async () => {
                failed.resolve()
                throw new Error("Private fixture failure")
              },
            },
            {
              id: "fixture-pending",
              open: async () => {
                pendingBoot.resolve()
                await detached.promise
                throw new Error("Fixture acquisition released")
              },
            },
            {
              id: "fixture-mismatch",
              open: async () => ({
                backend: nativeBackend(adapter),
                close: async () => {
                  mismatch.resolve()
                },
              }),
            },
            {
              ...module,
              open: async () => {
                const connection = await module.open()
                return {
                  backend: {
                    ...connection.backend,
                    onClose: (listener) => {
                      const unsubscribe = connection.backend.onClose?.(() => {
                        listener()
                        moduleDisconnected.resolve()
                      })
                      registered.resolve()
                      return unsubscribe ?? (() => {})
                    },
                    enqueue: async (input) => {
                      const accepted = await connection.backend.enqueue(input)
                      if (input.inputID === "host-lost-ack") throw new Error("Fixture lost native acknowledgment")
                      return accepted
                    },
                  },
                  close: async () => {
                    closes++
                    await connection.close()
                  },
                }
              },
            },
          ],
        ).pipe(Layer.provide(HttpServer.layerServices)),
      )
      const handler = Context.get(context, HttpRouter.HttpRouter)
        .asHttpEffect()
        .pipe(HttpEffect.toWebHandlerWith(context))
      const call = async (method: string, input: unknown) => {
        const url = new URL(`/api/rpc/experimental.conversation/${method}`, "http://assistant.local")
        url.searchParams.set("location[directory]", profile.workspace)
        const response = await handler(
          new Request(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ input }),
          }),
        )
        const body = (await response.json()) as { output: unknown }
        assert.equal(response.status, 200, `Native application RPC ${method} failed: ${JSON.stringify(body)}`)
        return body.output
      }
      // Trusted in-process composition owns acquisition; user config still cannot load arbitrary modules.
      yield* Effect.promise(() =>
        Promise.all([registered.promise, failed.promise, pendingBoot.promise, mismatch.promise]),
      )
      yield* Effect.addFinalizer(() => Effect.sync(() => detached.resolve()))
      assert.deepEqual(yield* Effect.promise(() => call("list", {})), [
        { id: "codex-native", label: "Codex", browse: true, execution: true, create: true, images: true },
      ])
      if (!resume)
        checks.push(
          "trusted module boot isolates failed, pending and mismatched modules without blocking the working backend",
        )
      assert.deepEqual(yield* Effect.promise(() => call("status", { backendID: "codex-native" })), {
        authentication: { state: "not-required" },
      })
      assert.equal(
        yield* Effect.promise(() =>
          call("cancelLogin", { backendID: "codex-native", loginID: "00000000-0000-0000-0000-000000000001" }),
        ),
        "not-found",
      )
      if (!resume) checks.push("native account projection and scoped login cancellation use the real application RPC")
      if (resume) {
        const retried = yield* Effect.promise(() =>
          call("send", { ref, inputID: "host-pending", text: "native-pending" }),
        )
        assert.deepEqual(retried, receipt)
        const refused = {
          ref,
          inputID: "host-stale-steer",
          text: "native-adjustment",
          delivery: "steer",
          expectedTurnID: "stale-turn",
        }
        assert.deepEqual(yield* Effect.promise(() => call("send", refused)), {
          ref,
          inputID: refused.inputID,
          status: "rejected",
          reason: "not-accepted",
        })
        assert.equal(requests.length, 4)
        checks.push("application SQLite restart returns the same receipt without native re-admission")
        const disconnected = Promise.withResolvers<void>()
        const unsubscribe = adapter.onClose(() => disconnected.resolve())
        yield* Effect.promise(() => stopSharedService({ executable: executable!, profile, apiKey: "fixture-only" }))
        yield* Effect.promise(() => disconnected.promise)
        yield* Effect.promise(() => moduleDisconnected.promise)
        unsubscribe()
        assert.deepEqual(yield* Effect.promise(() => call("list", {})), [])
        checks.push("native disconnection unregisters the backend from the real application RPC")
        return
      }
      const created = Schema.decodeUnknownSync(Created)(
        yield* Effect.promise(() => call("create", { backendID: "codex-native" })),
      )
      ref = created.thread.ref
      const sent = Schema.decodeUnknownSync(Admission)(
        yield* Effect.promise(() => call("send", { ref, inputID: "host-active", text: "native-active" })),
      )
      assert.equal(sent.status, "accepted")
      yield* Effect.promise(() => entered.promise)
      yield* Effect.promise(() => adapter.resume(ref.threadID))
      const running = Schema.decodeUnknownSync(Execution)(
        yield* Effect.promise(() => call("execution", { ref, limit: 1 })),
      )
      assert.equal(running.thread.state, "running")
      activeTurnID = running.turn?.id
      assert(activeTurnID)
      assert.equal(running.turn?.state, "running")
      assert.deepEqual(running.queue, [])
      const adjustment = {
        ref,
        inputID: "host-steer",
        text: "native-adjustment",
        delivery: "steer",
        expectedTurnID: activeTurnID,
      }
      const steered = Schema.decodeUnknownSync(Admission)(yield* Effect.promise(() => call("send", adjustment)))
      assert.equal(steered.status, "accepted")
      if (steered.status === "accepted") assert.equal(steered.receipt.kind, "steered")
      assert.deepEqual(yield* Effect.promise(() => call("send", adjustment)), steered)
      const refused = { ...adjustment, inputID: "host-stale-steer", expectedTurnID: "stale-turn" }
      const rejection = { ref, inputID: refused.inputID, status: "rejected", reason: "not-accepted" }
      assert.deepEqual(yield* Effect.promise(() => call("send", refused)), rejection)
      assert.deepEqual(yield* Effect.promise(() => call("send", refused)), rejection)
      checks.push("steering uses the same admission ID and the native active-turn guard")
      const duplicated = yield* Effect.promise(() =>
        Promise.all(
          Array.from({ length: 8 }, () => call("send", { ref, inputID: "host-pending", text: "native-pending" })),
        ),
      )
      assert(duplicated.some((value) => Schema.decodeUnknownSync(Admission)(value).status === "accepted"))
      receipt = yield* Effect.promise(() => call("send", { ref, inputID: "host-pending", text: "native-pending" }))
      assert.equal(Schema.decodeUnknownSync(Admission)(receipt).status, "accepted")
      const queued = yield* Effect.promise(() => adapter.queue(ref.threadID))
      assert.equal(queued.data.filter((entry) => entry.clientUserMessageId === "host-pending").length, 1)
      checks.push("eight concurrent HTTP copies create exactly one native queued submission")
      const lost = yield* Effect.promise(() => call("send", { ref, inputID: "host-lost-ack", text: "native-lost-ack" }))
      assert.equal(Schema.decodeUnknownSync(Admission)(lost).status, "uncertain")
      const recovered = yield* Effect.promise(() =>
        call("send", { ref, inputID: "host-lost-ack", text: "native-lost-ack" }),
      )
      assert.equal(Schema.decodeUnknownSync(Admission)(recovered).status, "accepted")
      assert.equal((yield* Effect.promise(() => adapter.queue(ref.threadID))).data.length, 2)
      checks.push("unknown native acknowledgment reconciles the real queue instead of re-sending")
      const snapshot = Schema.decodeUnknownSync(Execution)(
        yield* Effect.promise(() => call("execution", { ref, limit: 1 })),
      )
      assert.equal(snapshot.queue[0].inputID, "host-pending")
      assert(snapshot.nextCursor)
      const next = Schema.decodeUnknownSync(Execution)(
        yield* Effect.promise(() => call("execution", { ref, cursor: snapshot.nextCursor, limit: 1 })),
      )
      assert.equal(next.queue[0].inputID, "host-lost-ack")
      const remove = Schema.decodeUnknownSync(Admission)(
        yield* Effect.promise(() => call("send", { ref, inputID: "host-withdraw", text: "must-not-execute" })),
      )
      assert.equal(remove.status, "accepted")
      if (remove.status !== "accepted") throw new Error("Native queue acknowledgment missing")
      const pending = snapshot.queue[0].nativeID
      const lostID = next.queue[0].nativeID
      yield* Effect.promise(() =>
        call("control", {
          backendID: ref.backendID,
          control: { action: "update", threadID: ref.threadID, nativeID: pending, text: "native-pending-edited" },
        }),
      )
      yield* Effect.promise(() =>
        call("control", {
          backendID: ref.backendID,
          control: { action: "reorder", threadID: ref.threadID, nativeIDs: [lostID, pending, remove.receipt.nativeID] },
        }),
      )
      const withdrawal = {
        backendID: ref.backendID,
        control: { action: "withdraw", threadID: ref.threadID, nativeID: remove.receipt.nativeID },
      }
      assert.deepEqual(yield* Effect.promise(() => call("control", withdrawal)), { status: "applied" })
      assert.deepEqual(yield* Effect.promise(() => call("control", withdrawal)), { status: "not-found" })
      const reordered = Schema.decodeUnknownSync(Execution)(yield* Effect.promise(() => call("execution", { ref })))
      assert.deepEqual(
        reordered.queue.map((entry) => [entry.nativeID, entry.text]),
        [
          [lostID, "native-lost-ack"],
          [pending, "native-pending-edited"],
        ],
      )
      assert.equal(requests.length, 1)
      checks.push(
        "typed execution distinguishes active work from pending pages and native controls edit, reorder and withdraw only the original queue",
      )
      const db = Context.get(context, Database.Service).db
      const browse = yield* Effect.promise(() => call("threads", { backendID: "codex-native", limit: 1 }))
      const threadPage = Schema.decodeUnknownSync(
        Schema.Struct({
          items: Schema.Array(
            Schema.Struct({ ref: Schema.Struct({ backendID: Schema.String, threadID: Schema.String }) }),
          ),
        }),
      )(browse)
      assert.deepEqual(threadPage.items[0].ref, ref)
      // Reading a running thread must not create/resume it or admit another input.
      yield* Effect.promise(() => call("history", { ref, limit: 1 }))
      assert.equal(requests.length, 1)
      assert.equal((yield* Effect.promise(() => adapter.queue(ref.threadID))).data.length, 2)
      checks.push("read-only native projections preserve references without a second admission or model request")
      // Query the real database, never a mirrored Codex session or queue.
      assert.equal((yield* db.select({ id: SessionTable.id }).from(SessionTable).all()).length, 0)
      assert.equal((yield* db.select({ id: SessionInboxTable.id }).from(SessionInboxTable).all()).length, 0)
      checks.push("Codex inputs create no OpenCode Session or Inbox rows")
    }).pipe(Effect.scoped, Effect.provide(Logger.layer([]))),
  )
  assert.equal(closes, 1)
  if (!resume) {
    assert.equal((await adapter.read(ref.threadID)).thread.status.type, "active")
    checks.push(
      "application scope closes its module connection once while the native running task and observer stay alive",
    )
  }
}

try {
  await round(false)
  release.resolve()
  const deadline = setTimeout(() => finished.reject(new Error("Native completion deadline")), 30000)
  try {
    await finished.promise
  } finally {
    clearTimeout(deadline)
  }
  assert.equal(requests.length, 4)
  const native = nativeBackend(adapter)
  const recovered = await native.reconcile(ref!, "host-lost-ack")
  assert.equal(recovered?.kind, "message")
  checks.push("after queue consumption, native clientId resolves to the persisted user message")
  await round(true)
  console.log(
    JSON.stringify({ status: "passed", checks, model_requests: requests.length, production_credentials_used: false }),
  )
} finally {
  release.resolve()
  await adapter.close()
  await stopSharedService({ executable, profile, apiKey: "fixture-only" })
  upstream.stop(true)
}
