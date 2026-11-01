// Real native CLI, application RPC and SQLite. Synthetic local model, no QQ or production profile.
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
import { inputID, scopeKey } from "../../../../modules/qq-portal/src/routing"

const executable = process.env.IM_CODEX_EXECUTABLE,
  root = process.env.IM_QQ_GUIDANCE_TEST_ROOT
if (!executable || !root) throw new Error("Use an isolated native guidance test profile")
const checks: string[] = [],
  requests: unknown[] = []
const gates = Array.from({ length: 3 }, () => ({
  entered: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
}))
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method !== "POST") return Response.json({ data: [] })
    requests.push(await request.json())
    const serial = requests.length,
      gate = gates[serial - 1]
    if (gate) {
      gate.entered.resolve()
      await gate.release.promise
    }
    const item = {
      id: `msg_guidance_${serial}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: `native guidance reply ${serial}`, annotations: [] }],
    }
    const events = [
      { type: "response.created", response: { id: `resp_guidance_${serial}`, status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: {
          id: `resp_guidance_${serial}`,
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
const home = await mkdtemp(path.join(root, "native-guidance-"))
const profile = await createSharedProfile(path.join(home, "codex"), {
  id: "fixture",
  model: "local-fixture",
  baseURL: `http://127.0.0.1:${upstream.port}/v1`,
  keyName: "IM_FIXTURE_KEY",
})
const launch = { executable, profile, apiKey: "fixture-only" }
const observer = await CodexSessionAdapter.open(launch)
const finished = Promise.withResolvers<void>()
let completions = 0,
  admissions = 0
observer.subscribe((event) => {
  if (event.method === "turn/completed" && ++completions === 2) finished.resolve()
})
const policy = { botID: "10001", allowedUsers: ["20001"], allowedGroups: [] }
const scope: Scope = { botID: "10001", kind: "private", peerID: "20001" }
const source = (id: string) => ({ scope, messageID: id, actorID: "20001" })
const id = (value: string) => inputID(source(value))
const message = (value: string, text: string, quote?: string) => ({
  post_type: "message",
  message_type: "private",
  self_id: "10001",
  user_id: "20001",
  message_id: value,
  message: [...(quote ? [{ type: "reply", data: { id: quote } }] : []), { type: "text", data: { text } }],
})
const parent = message("parent", "Original native task")
const adjust = message("adjust", "Retain this native adjustment", "parent-reply")
const lost = message("lost", "Repair this native guidance receipt", "parent-reply")
const unknown = message("unknown", "Must never replay unknown guidance", "parent-reply")
let first: Extract<Target, { kind: "backend" }>, second: Extract<Target, { kind: "backend" }>, originalTurn: string
async function bounded<T>(promise: Promise<T>, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`Native guidance deadline: ${label}; requests=${requests.length}, admissions=${admissions}`),
            ),
          30000,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function round(restored: boolean) {
  await Effect.runPromise(
    Effect.gen(function* () {
      const ready = Promise.withResolvers<void>(),
        metadata = Promise.withResolvers<KV.Interface>()
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
                      const close = connection.backend.onClose?.(listener) ?? (() => {})
                      ready.resolve()
                      return close
                    },
                    enqueue: async (input) => {
                      admissions++
                      const result = await connection.backend.enqueue(input)
                      if (input.inputID === id("lost")) throw new Error("Synthetic native lost acknowledgment")
                      return result
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
        baseUrl: "http://native-guidance.local",
        fetch: Object.assign(
          (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => handler(new Request(input, init)),
          { preconnect: () => {} },
        ),
      })
      const rpc = app.rpc(ConversationBackend.Api),
        options = { location: { directory: profile.workspace } }
      const backend: Backend = {
        send: (input) => rpc.send(input, options),
        reconcile: (input) => rpc.reconcile(input, options),
        // Old facade intentionally has input identity but no terminal evidence. It must keep rejecting stale guidance.
        input: async (input) => {
          const value = await rpc.input(input, options)
          return value.status === "closed"
            ? {
                ref: value.ref,
                inputID: value.inputID,
                status: "delivered",
                nativeID: value.nativeID,
                turnID: value.turnID,
              }
            : value
        },
        execution: (input) => rpc.execution(input, options),
        query: (input) => rpc.query(input, options),
        control: (input) => rpc.control(input, options),
      }
      const kv = yield* Effect.promise(() => bounded(metadata.promise, "metadata"))
      const storage = {
        get: (key: string) => run(kv.get("qq-guidance:" + key)),
        set: (key: string, value: KV.Value) => run(kv.set("qq-guidance:" + key, value)),
        insert: (key: string, value: KV.Value) => run(kv.insert("qq-guidance:" + key, value)),
      }
      const portal = createPortal({ storage, policy, session: app.session, backend })
      yield* Effect.promise(() => bounded(ready.promise, "native module"))
      const call = <T>(promise: Promise<T>) => Effect.promise(() => bounded(promise, "RPC"))
      if (!restored) {
        first = { kind: "backend", ref: (yield* call(rpc.create({ backendID: "codex-native" }, options))).thread.ref }
        second = { kind: "backend", ref: (yield* call(rpc.create({ backendID: "codex-native" }, options))).thread.ref }
        // The pinned CLI refuses item history for a never-materialized thread. Failure is not "unknown" evidence.
        const empty = yield* call(
          backend.input!({ ref: first.ref, inputID: "unknown" }).then(
            () => null,
            (error: unknown) => error,
          ),
        )
        assert(empty && typeof empty === "object" && "type" in empty && empty.type === "failed")
        assert.equal((yield* kv.scan({ prefix: "conversation:admission:" })).entries.length, 0)
        assert.equal(admissions, 0)
        yield* call(portal.bind(scope, first))
        yield* call(portal.receive(parent))
        yield* call(gates[0].entered.promise)
        assert.equal((yield* call(backend.input!({ ref: first.ref, inputID: "unknown" }))).status, "unknown")
        // Fixture-only observer attach. QQ lookup and binding never resume the native thread.
        yield* call(observer.resume(first.ref.threadID))
        yield* call(portal.linkReply(source("parent"), "parent-reply"))
        const position = yield* call(backend.input!({ ref: first.ref, inputID: id("parent") }))
        assert(position.status === "delivered")
        originalTurn = position.turnID
        const admitted = yield* call(backend.reconcile({ ref: first.ref, inputID: id("parent") }))
        assert(admitted.status === "accepted" && admitted.receipt.kind === "queued")
        checks.push(
          "fresh native input RPC resolves the actual owning turn despite a cached queue admission; unknown lookup creates no admission",
        )
        yield* call(portal.receive(message("second", "Next independent native task")))
        assert.equal(
          (yield* call(portal.receive(message("pending-adjust", "Must not replace a queued task", "second")))).status,
          "blocked",
        )
        assert.equal((yield* call(observer.queue(first.ref.threadID))).data.length, 1)
        yield* call(portal.bind(scope, second))
        const proposal = yield* call(portal.receive(adjust))
        assert(proposal.status === "confirmation-required")
        assert.equal(admissions, 2)
        const approval = {
          confirmationID: proposal.confirmationID,
          scope,
          actorID: "20001",
          choice: "approve" as const,
        }
        const copies = yield* call(Promise.all(Array.from({ length: 6 }, () => portal.confirm(adjust, approval))))
        assert(copies.some((value) => value.status === "steered" && value.delivery === "accepted"))
        assert.equal(admissions, 3)
        assert.deepEqual(yield* call(storage.get("binding:" + scopeKey(scope))), second)
        checks.push(
          "cross-session confirmation uses the same native turn fence and leaves the bound conversation unchanged",
        )
        yield* call(portal.bind(scope, first))
        yield* call(portal.linkReply(source("adjust"), "adjust-reply"))
        assert.equal(
          (yield* call(
            portal.receive({
              post_type: "notice",
              notice_type: "friend_recall",
              self_id: "10001",
              user_id: "20001",
              message_id: "adjust",
            }),
          )).status,
          "unchanged",
        )
        checks.push(
          "quoted native input steers only its expected turn once; queued quotes are not replaced and guidance recall does not cancel the parent",
        )
        yield* call(portal.receive(lost))
        const unavailable = createPortal({
          storage,
          policy,
          session: app.session,
          backend: {
            ...backend,
            send: async () => {
              throw new Error("Before application admission")
            },
          },
        })
        assert.equal((yield* call(unavailable.receive(unknown))).status, "uncertain")
        assert.equal((yield* call(portal.receive(unknown))).status, "uncertain")
        assert.equal(admissions, 4)
        gates[0].release.resolve()
        yield* call(gates[1].entered.promise)
        const repaired = yield* call(portal.receive(lost))
        assert(repaired.status === "steered" && repaired.delivery === "delivered")
        const delivered = yield* call(backend.input!({ ref: first.ref, inputID: id("lost") }))
        assert(delivered.status === "delivered" && delivered.turnID === originalTurn)
        assert(JSON.stringify(requests[1]).includes("Retain this native adjustment"))
        assert(JSON.stringify(requests[1]).includes("Repair this native guidance receipt"))
        assert.equal(admissions, 4)
        checks.push(
          "a genuinely lost native acknowledgment repairs from the delivered client ID and original turn without posting guidance twice",
        )
        yield* call(portal.bind(scope, second))
      } else {
        assert.equal((yield* call(portal.receive(adjust))).status, "steered")
        assert.equal((yield* call(portal.receive(lost))).status, "steered")
        assert.equal((yield* call(portal.receive(unknown))).status, "uncertain")
        assert.equal(admissions, 4)
        assert.equal(requests.length, 2)
        assert.deepEqual(yield* call(portal.sourceFor(first, id("parent"))), {
          status: "found",
          source: source("parent"),
        })
        assert.equal((yield* call(observer.queue(second.ref.threadID))).data.length, 0)
        checks.push(
          "SQLite reopen and binding changes retain native target and turn fence; duplicate and unknown guidance only reconcile",
        )
        yield* call(portal.bind(scope, first))
        gates[1].release.resolve()
        yield* call(gates[2].entered.promise)
        const current = yield* call(backend.execution({ ref: first.ref }))
        assert(current.turn && current.turn.id !== originalTurn)
        const late = message("late", "Must not enter the next task", "parent-reply")
        assert.deepEqual(yield* call(portal.receive(late)), { status: "blocked", reason: "quoted-task-not-active" })
        assert.deepEqual(yield* call(portal.receive(late)), { status: "blocked", reason: "quoted-task-not-active" })
        assert.equal(admissions, 5)
        assert.equal((yield* call(observer.queue(first.ref.threadID))).data.length, 0)
        checks.push(
          "after native queue advances, stale quoted turn is structurally refused and never converted to a new queued task",
        )
        gates[2].release.resolve()
        yield* call(finished.promise)
        assert.equal(requests.length, 3)
        assert(!JSON.stringify(requests).includes("Must not enter the next task"))
        assert(!JSON.stringify(requests).includes("Must never replay unknown guidance"))
        assert(!JSON.stringify(requests).includes("Must not replace a queued task"))
        assert(!JSON.stringify(yield* kv.scan({ prefix: "qq-guidance:" })).includes("Retain this native adjustment"))
        checks.push(
          "only native Codex runs queued and steering work; QQ stores no body, execution state or second queue",
        )
      }
      const db = Context.get(context, Database.Service).db
      assert.equal((yield* db.select({ id: SessionTable.id }).from(SessionTable).all()).length, 0)
      assert.equal((yield* db.select({ id: SessionInboxTable.id }).from(SessionInboxTable).all()).length, 0)
    }).pipe(Effect.scoped, Effect.provide(Logger.layer([]))),
  )
}
try {
  await round(false)
  await round(true)
  checks.push("real native guidance creates zero shadow Session or Inbox rows across host restart")
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
  gates.forEach((gate) => gate.release.resolve())
  await observer.close()
  await stopSharedService(launch)
  upstream.stop(true)
}
