// Isolated real CLI + application RPC + SQLite test. No production profile or QQ connection.
import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import path from "node:path"
import { Context, Effect, Layer, Logger } from "effect"
import { HttpEffect, HttpRouter, HttpServer } from "effect/http"
import { OpenCode } from "@opencode/client"
import { Database } from "@opencode/core/database/database"
import { KV } from "@opencode/core/kv"
import { SessionTable, SessionInboxTable } from "@opencode/core/session/sql"
import { ConversationBackend } from "@opencode/schema/conversation-backend"
import { createEmbeddedRoutes } from "../src/routes"
import {
  CodexSessionAdapter,
  createSharedProfile,
  nativeModule,
  stopSharedService,
} from "../../../../modules/codex-native/src"
import { createPortal, type Backend, type Scope, type Target } from "../../../../modules/qq-portal/src"
import { decode, inputID } from "../../../../modules/qq-portal/src/routing"

const executable = process.env.IM_CODEX_EXECUTABLE
const root = process.env.IM_QQ_BACKEND_TEST_ROOT
if (!executable || !root) throw new Error("Use tools.qq_portal_smoke with an isolated native profile")
const checks: string[] = []
const requests: unknown[] = []
const entered = Promise.withResolvers<void>()
const release = Promise.withResolvers<void>()
const completed = Promise.withResolvers<void>()
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
      id: `msg_qq_native_${serial}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: `native QQ reply ${serial}`, annotations: [] }],
    }
    const events = [
      { type: "response.created", response: { id: `resp_qq_${serial}`, status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: {
          id: `resp_qq_${serial}`,
          status: "completed",
          output: [item],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
      },
    ]
    return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    })
  },
})
const home = await mkdtemp(path.join(root, "qq-native-"))
const profile = await createSharedProfile(path.join(home, "codex"), {
  id: "fixture",
  model: "local-fixture",
  baseURL: `http://127.0.0.1:${upstream.port}/v1`,
  keyName: "IM_FIXTURE_KEY",
})
const launch = { executable, profile, apiKey: "fixture-only" }
const adapter = await CodexSessionAdapter.open(launch)
let completions = 0,
  admissions = 0,
  sessionPrompts = 0
adapter.subscribe((event) => {
  if (event.method === "turn/completed" && ++completions === 4) completed.resolve()
})
const policy = { botID: "10001", allowedUsers: ["20001"], allowedGroups: [] }
const scope: Scope = { botID: "10001", kind: "private", peerID: "20001" }
const message = (id: string, text: string, quote?: string) => ({
  post_type: "message",
  message_type: "private",
  self_id: "10001",
  user_id: "20001",
  message_id: id,
  message: [...(quote ? [{ type: "reply", data: { id: quote } }] : []), { type: "text", data: { text } }],
})
const kept = message("kept", "QQ native kept input")
const lost = message("lost", "QQ native lost acknowledgment")
const unknown = message("unknown", "Must not replay an unknown handoff")
const origin = (raw: unknown) => {
  const value = decode(raw, policy)
  if (value.kind !== "message") throw new Error("Expected message")
  return value.message
}
const lostID = inputID(origin(lost))
let first: Extract<Target, { kind: "backend" }>, second: Extract<Target, { kind: "backend" }>
async function bounded<T>(promise: Promise<T>, label: string) {
  let timer: ReturnType<typeof setTimeout>
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Native QQ test deadline: ${label}; requests=${requests.length}, admissions=${admissions}, completions=${completions}`,
              ),
            ),
          30_000,
        )
      }),
    ])
  } finally {
    clearTimeout(timer!)
  }
}

async function round(restored: boolean) {
  await Effect.runPromise(
    Effect.gen(function* () {
      const ready = Promise.withResolvers<void>()
      const metadata = Promise.withResolvers<KV.Interface>()
      const module = nativeModule(launch)
      const context = yield* Layer.build(
        createEmbeddedRoutes(
          {
            database: { path: path.join(home, "application.sqlite") },
            models: { fetch: false },
            runtime: { managedDirectory: profile.workspace },
            config: { directory: path.join(home, "config"), project: false, claude: false, content: "{}" },
            fs: { filewatcher: false },
          },
          [
            KV.node.replace(
              KV.node.mapLayer((layer) =>
                layer.pipe(
                  Layer.tap((services) => Effect.sync(() => metadata.resolve(Context.get(services, KV.Service)))),
                ),
              ),
            ),
          ],
          undefined,
          [
            {
              ...module,
              open: async () => {
                const connection = await module.open()
                return {
                  ...connection,
                  backend: {
                    ...connection.backend,
                    onClose: (listener) => {
                      const close = connection.backend.onClose?.(listener)
                      ready.resolve()
                      return close ?? (() => {})
                    },
                    enqueue: async (input) => {
                      admissions++
                      const receipt = await connection.backend.enqueue(input)
                      if (input.inputID === lostID) throw new Error("Synthetic native lost acknowledgment")
                      return receipt
                    },
                  },
                }
              },
            },
          ],
        ).pipe(Layer.provide(HttpServer.layerServices)),
      )
      const run = Effect.runPromiseWith(context)
      const handler = Context.get(context, HttpRouter.HttpRouter)
        .asHttpEffect()
        .pipe(HttpEffect.toWebHandlerWith(context))
      const app = OpenCode.make({
        baseUrl: "http://qq-native.local",
        fetch: Object.assign(
          (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => handler(new Request(input, init)),
          { preconnect: () => {} },
        ),
      })
      const rpc = app.rpc(ConversationBackend.Api)
      const options = { location: { directory: profile.workspace } }
      const backend: Backend = {
        send: (input) => rpc.send(input, options),
        reconcile: (input) => rpc.reconcile(input, options),
        execution: (input) => rpc.execution(input, options),
        control: (input) => rpc.control(input, options),
        query: (input) => rpc.query(input, options),
      }
      const kv = yield* Effect.promise(() => bounded(metadata.promise, "metadata"))
      // Test-only namespace over the same original SQLite KV service; no second metadata database.
      const storage = {
        get: (key: string) => run(kv.get("qq-test:" + key)),
        set: (key: string, value: KV.Value) => run(kv.set("qq-test:" + key, value)),
        insert: (key: string, value: KV.Value) => run(kv.insert("qq-test:" + key, value)),
      }
      const portal = createPortal({
        policy,
        storage,
        backend,
        session: {
          ...app.session,
          prompt: async (input) => {
            sessionPrompts++
            return app.session.prompt(input)
          },
        },
      })
      yield* Effect.promise(() => bounded(ready.promise, "module ready"))
      if (!restored) {
        first = {
          kind: "backend",
          ref: (yield* Effect.promise(() => rpc.create({ backendID: "codex-native" }, options))).thread.ref,
        }
        second = {
          kind: "backend",
          ref: (yield* Effect.promise(() => rpc.create({ backendID: "codex-native" }, options))).thread.ref,
        }
        assert.equal(
          (yield* Effect.promise(() => backend.reconcile({ ref: first.ref, inputID: "never-submitted" }))).status,
          "uncertain",
        )
        assert.equal((yield* kv.scan({ prefix: "conversation:admission:" })).entries.length, 0)
        assert.equal(admissions, 0)
        checks.push(
          "receipt-only application RPC for unknown input does not create an admission, resume or model request",
        )
        yield* Effect.promise(() =>
          rpc.send({ ref: first.ref, inputID: "desktop-active", text: "Desktop native active" }, options),
        )
        yield* Effect.promise(() => bounded(entered.promise, "first token gate"))
        // Explicit test observer attachment, like codex-backend-smoke; read-only QQ binding never resumes a thread.
        yield* Effect.promise(() => adapter.resume(first.ref.threadID))
        yield* Effect.promise(() => portal.bind(scope, first))
        const copies = yield* Effect.promise(() => Promise.all(Array.from({ length: 8 }, () => portal.receive(kept))))
        assert(
          copies.some((item) => item.status === "accepted" && JSON.stringify(item.target) === JSON.stringify(first)),
        )
        assert.equal((yield* Effect.promise(() => adapter.queue(first.ref.threadID))).data.length, 1)
        assert.equal(admissions, 2)
        checks.push(
          "eight QQ copies reach one native submission through the same real application RPC as desktop input",
        )
        const unknownPortal = createPortal({
          policy,
          storage,
          session: app.session,
          backend: {
            ...backend,
            send: async () => {
              throw new Error("Before application admission")
            },
          },
        })
        assert.equal((yield* Effect.promise(() => unknownPortal.receive(unknown))).status, "uncertain")
        assert.equal((yield* Effect.promise(() => portal.receive(unknown))).status, "uncertain")
        assert.equal(admissions, 2)
        assert.equal((yield* Effect.promise(() => portal.receive(lost))).status, "uncertain")
        assert.equal((yield* Effect.promise(() => portal.receive(lost))).status, "accepted")
        assert.equal(admissions, 3)
        checks.push(
          "unknown pre-admission is not replayed; lost native acknowledgment repairs only its original durable receipt",
        )
        yield* Effect.promise(() => portal.receive(message("withdraw", "Must never execute recalled QQ input")))
        assert.deepEqual(
          yield* Effect.promise(() =>
            portal.receive({
              post_type: "notice",
              notice_type: "friend_recall",
              self_id: "10001",
              user_id: "20001",
              message_id: "withdraw",
            }),
          ),
          { status: "withdrawn" },
        )
        assert.equal((yield* Effect.promise(() => adapter.queue(first.ref.threadID))).data.length, 2)
        yield* Effect.promise(() =>
          rpc.send({ ref: first.ref, inputID: "desktop-pending", text: "Desktop native queued" }, options),
        )
        const queue = yield* Effect.promise(() => adapter.queue(first.ref.threadID))
        assert.deepEqual(
          queue.data.map((item) => item.clientUserMessageId),
          [inputID(origin(kept)), lostID, "desktop-pending"],
        )
        assert.equal(admissions, 5)
        checks.push(
          "QQ recall deletes only a native pending submission; desktop and QQ still share the original native FIFO",
        )
        yield* Effect.promise(() => portal.linkReply(origin(kept), "native-outgoing"))
        yield* Effect.promise(() => portal.bind(scope, second))
        const duplicate = yield* Effect.promise(() => portal.receive(kept))
        assert(duplicate.status === "accepted" && JSON.stringify(duplicate.target) === JSON.stringify(first))
        assert.deepEqual(
          yield* Effect.promise(() => portal.receive(message("cross", "Different target", "native-outgoing"))),
          { status: "blocked", reason: "cross-session-confirmation-required" },
        )
        assert.equal((yield* Effect.promise(() => adapter.queue(second.ref.threadID))).data.length, 0)
        assert(!JSON.stringify(yield* kv.scan({ prefix: "qq-test:" })).includes("QQ native kept input"))
        checks.push(
          "backend targets and acknowledged aliases stay frozen through rebinding; no body or task queue is mirrored in QQ metadata",
        )
      } else {
        const duplicate = yield* Effect.promise(() => portal.receive(kept))
        assert(duplicate.status === "accepted" && JSON.stringify(duplicate.target) === JSON.stringify(first))
        assert.equal((yield* Effect.promise(() => portal.receive(lost))).status, "accepted")
        assert.equal((yield* Effect.promise(() => portal.receive(unknown))).status, "uncertain")
        assert.equal(admissions, 5)
        assert.equal(requests.length, 1)
        checks.push(
          "application SQLite restart restores both targets and receipts without resuming, re-admitting or moving old input",
        )
        release.resolve()
        yield* Effect.promise(() => bounded(completed.promise, "native completion"))
        const history = yield* Effect.promise(() => rpc.history({ ref: first.ref }, options))
        assert.deepEqual(
          history.items.filter((item) => item.kind === "user").map((item) => item.text),
          ["Desktop native active", "QQ native kept input", "QQ native lost acknowledgment", "Desktop native queued"],
        )
        assert.equal(requests.length, 4)
        assert(!JSON.stringify(requests).includes("Must never execute recalled QQ input"))
        assert(!JSON.stringify(requests).includes("Must not replay an unknown handoff"))
        assert.deepEqual(
          yield* Effect.promise(() =>
            portal.receive({
              post_type: "notice",
              notice_type: "friend_recall",
              self_id: "10001",
              user_id: "20001",
              message_id: "kept",
            }),
          ),
          { status: "unchanged" },
        )
        checks.push(
          "the real native CLI completes ordered inputs after host restart; delivered recall never interrupts native work",
        )
      }
      const db = Context.get(context, Database.Service).db
      assert.equal((yield* db.select({ id: SessionTable.id }).from(SessionTable).all()).length, 0)
      assert.equal((yield* db.select({ id: SessionInboxTable.id }).from(SessionInboxTable).all()).length, 0)
      assert.equal(sessionPrompts, 0)
    }).pipe(Effect.scoped, Effect.provide(Logger.layer([]))),
  )
}

try {
  await round(false)
  await round(true)
  checks.push("native QQ traffic creates zero OpenCode Session or Inbox rows and never calls Session.prompt")
  console.log(
    JSON.stringify({
      status: "passed",
      checks,
      model_requests: requests.length,
      native_admissions: admissions,
      actual_qq_connection: false,
      external_messages_sent: 0,
      production_credentials_used: false,
    }),
  )
} finally {
  release.resolve()
  await adapter.close()
  await stopSharedService(launch)
  upstream.stop(true)
}
