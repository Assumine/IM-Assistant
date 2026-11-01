// Actual pinned Codex CLI + application RPC + SQLite. Synthetic model, no QQ or production credentials.
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
  root = process.env.IM_QQ_NATIVE_FOLLOWUP_ROOT
if (!executable || !root) throw new Error("Use an isolated native follow-up fixture")
const checks: string[] = [],
  requests: unknown[] = []
const entered = Array.from({ length: 2 }, () => Promise.withResolvers<void>())
const release = Array.from({ length: 2 }, () => Promise.withResolvers<void>())
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method !== "POST") return Response.json({ data: [] })
    requests.push(await request.json())
    const serial = requests.length
    if (serial <= 2) {
      entered[serial - 1].resolve()
      await release[serial - 1].promise
    }
    const item = {
      id: `msg_native_followup_${serial}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: `native follow-up ${serial}`, annotations: [] }],
    }
    const events = [
      { type: "response.created", response: { id: `resp_followup_${serial}`, status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: {
          id: `resp_followup_${serial}`,
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
const home = await mkdtemp(path.join(root, "native-linked-"))
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
  admissions = 0,
  followups = 0
observer.subscribe((event) => {
  if (event.method === "turn/completed" && ++completions === 4) finished.resolve()
})
const policy = { botID: "10001", allowedUsers: ["20001"], allowedGroups: [] }
const scope: Scope = { botID: "10001", kind: "private", peerID: "20001" }
const source = (messageID: string) => ({ scope, actorID: "20001", messageID })
const id = (name: string) => inputID(source(name))
const message = (name: string, text: string, quote?: string) => ({
  post_type: "message",
  message_type: "private",
  self_id: "10001",
  user_id: "20001",
  message_id: name,
  message: [...(quote ? [{ type: "reply", data: { id: quote } }] : []), { type: "text", data: { text } }],
})
const firstMessage = message("parent", "Native original task")
const child = message("child", "Native linked child", "parent-final")
const lost = message("lost", "Native linked lost acknowledgment", "parent-final")
const unknown = message("unknown", "Must not replay unknown linked handoff", "parent-final")
let first: Extract<Target, { kind: "backend" }>,
  second: Extract<Target, { kind: "backend" }>,
  parent: ConversationBackend.ParentInput
async function bounded<T>(promise: Promise<T>, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Native linked deadline ${label}: requests=${requests.length}, admissions=${admissions}, followups=${followups}`,
              ),
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
                      const stop = connection.backend.onClose?.(listener) ?? (() => {})
                      ready.resolve()
                      return stop
                    },
                    enqueue: async (request) => {
                      admissions++
                      return connection.backend.enqueue(request)
                    },
                    followup: async (request) => {
                      admissions++
                      followups++
                      const result = await connection.backend.followup!(request)
                      if (request.inputID === id("lost"))
                        throw new Error("Synthetic native follow-up acknowledgment loss")
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
        baseUrl: "http://native-linked.local",
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
        input: (input) => rpc.input(input, options),
        execution: (input) => rpc.execution(input, options),
        query: (input) => rpc.query(input, options),
        control: (input) => rpc.control(input, options),
      }
      const kv = yield* Effect.promise(() => bounded(metadata.promise, "metadata"))
      const storage = {
        get: (key: string) => run(kv.get("qq-native-linked:" + key)),
        set: (key: string, value: KV.Value) => run(kv.set("qq-native-linked:" + key, value)),
        insert: (key: string, value: KV.Value) => run(kv.insert("qq-native-linked:" + key, value)),
      }
      const portal = createPortal({ policy, storage, backend, session: app.session })
      yield* Effect.promise(() => bounded(ready.promise, "native module"))
      const call = <T>(promise: Promise<T>) => Effect.promise(() => bounded(promise, "RPC"))
      if (!restored) {
        first = { kind: "backend", ref: (yield* call(rpc.create({ backendID: "codex-native" }, options))).thread.ref }
        second = { kind: "backend", ref: (yield* call(rpc.create({ backendID: "codex-native" }, options))).thread.ref }
        yield* call(portal.bind(scope, first))
        yield* call(portal.receive(firstMessage))
        yield* call(entered[0].promise)
        yield* call(observer.resume(first.ref.threadID)) // Fixture observer attachment only; input reads never resume.
        yield* call(portal.linkReply(source("parent"), "parent-final"))
        const active = yield* call(backend.input!({ ref: first.ref, inputID: id("parent") }))
        assert(active.status === "delivered")
        parent = { inputID: id("parent"), turnID: active.turnID, nativeID: active.nativeID }
        assert.equal(
          (yield* call(
            backend.send({
              ref: first.ref,
              inputID: "must-refuse-active-parent",
              text: "Must not follow active parent",
              followupOf: parent,
            }),
          )).status,
          "rejected",
        )
        yield* call(
          backend.send({ ref: first.ref, inputID: "desktop-successor", text: "Independent native successor" }),
        )
        release[0].resolve()
        yield* call(entered[1].promise)
        const closed = yield* call(backend.input!({ ref: first.ref, inputID: id("parent") }))
        assert(
          closed.status === "closed" &&
            closed.turnID === parent.turnID &&
            closed.nativeID === parent.nativeID &&
            closed.state === "completed",
        )
        const execution = yield* call(backend.execution({ ref: first.ref }))
        assert(execution.turn && execution.turn.id !== parent.turnID && execution.turn.state === "running")
        checks.push(
          "exact native parent termination is proven while a different successor runs; active parents cannot admit linked work",
        )
        yield* call(portal.bind(scope, second))
        const proposal = yield* call(portal.receive(child))
        assert(proposal.status === "confirmation-required")
        const approval = {
          confirmationID: proposal.confirmationID,
          scope,
          actorID: "20001",
          choice: "approve" as const,
        }
        const copies = yield* call(Promise.all(Array.from({ length: 6 }, () => portal.confirm(child, approval))))
        assert(
          copies.some(
            (result) =>
              result.status === "followup" && result.inputID === id("child") && result.delivery === "accepted",
          ),
        )
        assert.equal(followups, 2)
        const receipt = yield* call(backend.reconcile({ ref: first.ref, inputID: id("child") }))
        assert(receipt.status === "accepted")
        assert.deepEqual(receipt.followupOf, parent)
        assert.deepEqual(yield* call(storage.get("binding:" + scopeKey(scope))), second)
        assert.deepEqual(yield* call(portal.sourceFor(first, id("child"))), {
          status: "found",
          source: source("child"),
        })
        assert.deepEqual(yield* call(portal.sourceFor(first, id("parent"))), {
          status: "found",
          source: source("parent"),
        })
        checks.push(
          "cross-conversation consent creates one native child with its own source and immutable parent while keeping the current binding",
        )
        const cancelled = message("cancelled", "Must not execute cancelled native follow-up", "parent-final")
        const cp = yield* call(portal.receive(cancelled))
        assert(cp.status === "confirmation-required")
        assert.equal(
          (yield* call(portal.confirm(cancelled, { ...approval, confirmationID: cp.confirmationID }))).status,
          "followup",
        )
        assert.equal(
          (yield* call(
            portal.receive({
              post_type: "notice",
              notice_type: "friend_recall",
              self_id: "10001",
              user_id: "20001",
              message_id: "cancelled",
            }),
          )).status,
          "withdrawn",
        )
        checks.push("recalling a linked native submission deletes only the child from the original native queue")
        const lp = yield* call(portal.receive(lost))
        assert(lp.status === "confirmation-required")
        assert.equal(
          (yield* call(portal.confirm(lost, { ...approval, confirmationID: lp.confirmationID }))).status,
          "uncertain",
        )
        assert.equal((yield* call(portal.receive(lost))).status, "followup")
        const unavailable = createPortal({
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
        const up = yield* call(unavailable.receive(unknown))
        assert(up.status === "confirmation-required")
        assert.equal(
          (yield* call(unavailable.confirm(unknown, { ...approval, confirmationID: up.confirmationID }))).status,
          "uncertain",
        )
        assert.equal((yield* call(portal.receive(unknown))).status, "uncertain")
        assert.equal(
          (yield* call(
            backend.send({
              ref: first.ref,
              inputID: "must-refuse-wrong-parent",
              text: "Must not follow wrong native parent",
              followupOf: { ...parent, nativeID: "wrong-native-message" },
            }),
          )).status,
          "rejected",
        )
        assert.equal(followups, 5)
        assert.equal(admissions, 7)
        const queue = yield* call(observer.queue(first.ref.threadID))
        assert.deepEqual(
          queue.data.map((row) => row.clientUserMessageId),
          [id("child"), id("lost")],
        )
        checks.push(
          "lost acknowledgments repair only the original linked receipt; unknown handoffs and wrong parent identities never replay",
        )
      } else {
        const duplicate = yield* call(portal.receive(child))
        assert(duplicate.status === "followup" && JSON.stringify(duplicate.target) === JSON.stringify(first))
        assert.equal((yield* call(portal.receive(lost))).status, "followup")
        assert.equal((yield* call(portal.receive(unknown))).status, "uncertain")
        assert.equal(admissions, 7)
        assert.equal(requests.length, 2)
        const restoredReceipt = yield* call(backend.reconcile({ ref: first.ref, inputID: id("child") }))
        assert(restoredReceipt.status === "accepted")
        assert.deepEqual(restoredReceipt.followupOf, parent)
        assert.equal((yield* call(observer.queue(second.ref.threadID))).data.length, 0)
        checks.push(
          "application SQLite reopen preserves target, new source and parent relation without resuming or submitting the input again",
        )
        release[1].resolve()
        yield* call(finished.promise)
        assert.equal(requests.length, 4)
        const history = yield* call(rpc.history({ ref: first.ref }, options))
        assert.deepEqual(
          history.items.filter((row) => row.kind === "user").map((row) => row.text),
          [
            "Native original task",
            "Independent native successor",
            "Native linked child",
            "Native linked lost acknowledgment",
          ],
        )
        assert(!JSON.stringify(requests).includes("Must not execute cancelled native follow-up"))
        assert(!JSON.stringify(requests).includes("Must not replay unknown linked handoff"))
        assert(!JSON.stringify(requests).includes("Must not follow active parent"))
        assert(!JSON.stringify(requests).includes("Must not follow wrong native parent"))
        checks.push(
          "the native CLI alone drains the successor and linked children in order, with no cancelled, refused or unknown input",
        )
        const childState = yield* call(backend.input!({ ref: first.ref, inputID: id("child") }))
        assert(childState.status === "closed" && childState.turnID !== parent.turnID)
        assert.equal((yield* call(portal.receive(child))).status, "followup")
        assert.equal((yield* call(portal.receive(lost))).status, "followup")
        assert.equal(requests.length, 4)
        assert.equal(admissions, 7)
        assert(!JSON.stringify(yield* kv.scan({ prefix: "qq-native-linked:" })).includes("Native linked child"))
        checks.push(
          "historical linked acceptance is not a running/pending claim and repeated delivery never starts another model request",
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
  checks.push("linked native tasks create zero shadow OpenCode Session/Inbox rows and use no QQ connection")
  console.log(
    JSON.stringify({
      status: "passed",
      checks,
      model_requests: requests.length,
      native_admissions: admissions,
      followup_calls: followups,
      actual_qq_connection: false,
      external_messages_sent: 0,
      production_credentials_used: false,
    }),
  )
} finally {
  release.forEach((gate) => gate.resolve())
  await observer.close()
  await stopSharedService(launch)
  upstream.stop(true)
}
