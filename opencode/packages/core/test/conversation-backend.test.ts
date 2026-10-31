import { expect } from "bun:test"
import { Effect, Layer, Deferred, Fiber, Exit, Logger, Stream } from "effect"
import type { Definition } from "@opencode/plugin/effect/conversation"
import { ConversationBackend } from "@opencode/core/conversation-backend"
import {
  Api,
  type Activity,
  type Admission,
  type Content,
  type Input,
  type Receipt,
} from "@opencode/schema/conversation-backend"
import { Database } from "@opencode/core/database/database"
import { KV } from "@opencode/core/kv"
import { Rpc } from "@opencode/core/rpc"
import { Location } from "@opencode/core/location"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { AbsolutePath } from "@opencode/core/schema"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ConversationBackend.node, Rpc.node, KV.node, Database.node]), [
    Location.node.replace(Layer.succeed(Location.Service, location({ directory: AbsolutePath.make("/backend-test") }))),
  ]),
)

function fixture() {
  const admissions: Input[] = []
  const receipts = new Map<string, Receipt>()
  let closed = 0
  const backend: Definition = {
    descriptor: { id: "example", label: "Example native backend" },
    create: async () => ({ nativeThread: "native-thread" }),
    query: async () => ({ nativeHistory: [] }),
    control: async () => ({ status: "applied" }),
    enqueue: async (input) => {
      admissions.push(input)
      const receipt = { nativeID: `native-${admissions.length}`, kind: "queued" as const }
      receipts.set(input.inputID, receipt)
      return receipt
    },
    reconcile: async (_ref, id) => receipts.get(id),
    subscribe: () => () => {
      closed++
    },
  }
  return { backend, admissions, receipts, closed: () => closed }
}
const input = {
  ref: { backendID: "example", threadID: "native-thread" },
  inputID: "input-1",
  text: "private-input-not-stored-in-receipts",
}

it.effect("public native RPC is optional, and backend registration is scoped and unique", () =>
  Effect.gen(function* () {
    const host = yield* ConversationBackend.Service
    const rpc = yield* Rpc.Service
    yield* host.bind(rpc)
    const client = rpc.client(Api)
    expect(yield* client.list({})).toEqual([])
    expect(Exit.isFailure(yield* client.send(input).pipe(Effect.exit))).toBe(true)
    const example = fixture()
    const registered = yield* host.register(example.backend)
    expect(yield* client.list({})).toEqual([example.backend.descriptor])
    expect(yield* client.create({ backendID: "example" })).toEqual({ nativeThread: "native-thread" })
    expect(yield* client.status({ backendID: "example" })).toEqual({ authentication: null })
    expect(Exit.isFailure(yield* client.login({ backendID: "example" }).pipe(Effect.exit))).toBe(true)
    expect(Exit.isFailure(yield* client.threads({ backendID: "example" }).pipe(Effect.exit))).toBe(true)
    expect(Exit.isFailure(yield* client.history({ ref: input.ref }).pipe(Effect.exit))).toBe(true)
    expect(Exit.isFailure(yield* client.execution({ ref: input.ref }).pipe(Effect.exit))).toBe(true)
    expect(Exit.isFailure(yield* host.register(example.backend).pipe(Effect.exit))).toBe(true)
    yield* registered.dispose
    yield* registered.dispose
    expect(example.closed()).toBe(1)
    expect(yield* client.list({})).toEqual([])
  }),
)

it.effect("read-only projections preserve pagination and reject a different native owner", () =>
  Effect.gen(function* () {
    const host = yield* ConversationBackend.Service
    const rpc = yield* Rpc.Service
    const example = fixture()
    const thread = { ref: input.ref, title: "Native title", state: "unloaded" as const }
    const calls: object[] = []
    let mismatched = false
    yield* host.bind(rpc)
    yield* host.register({
      ...example.backend,
      browse: {
        threads: async (page) => {
          calls.push(page)
          return {
            items: [
              { ...thread, updatedAt: undefined, ref: mismatched ? { ...input.ref, backendID: "other" } : input.ref },
            ],
            nextCursor: "native-next",
          }
        },
        history: async (ref, page) => {
          calls.push({ ref, page })
          return {
            thread: { ...thread, ref: mismatched ? { ...ref, threadID: "other-thread" } : ref },
            items: [{ id: "native-item", turnID: "native-turn", kind: "user", text: "Native body", partial: false }],
            nextCursor: "native-earlier",
          }
        },
      },
    })
    const client = rpc.client(Api)
    expect(yield* client.threads({ backendID: "example", cursor: "opaque-list", limit: 2 })).toEqual({
      items: [thread],
      nextCursor: "native-next",
    })
    expect((yield* client.history({ ref: input.ref, cursor: "opaque-history", limit: 3 })).items[0].id).toBe(
      "native-item",
    )
    expect(calls).toEqual([
      { cursor: "opaque-list", limit: 2 },
      { ref: input.ref, page: { cursor: "opaque-history", limit: 3 } },
    ])
    mismatched = true
    expect(Exit.isFailure(yield* client.threads({ backendID: "example" }).pipe(Effect.exit))).toBe(true)
    expect(Exit.isFailure(yield* client.history({ ref: input.ref }).pipe(Effect.exit))).toBe(true)
    expect(example.admissions).toEqual([])
  }),
)

it.effect("execution observations and invalidations retain native ownership across registration changes", () =>
  Effect.gen(function* () {
    const host = yield* ConversationBackend.Service
    const rpc = yield* Rpc.Service
    yield* host.bind(rpc)
    const example = fixture()
    const calls: object[] = []
    let emit = (_event: Activity) => {}
    let emitContent = (_event: Content) => {}
    let contentClosed = 0
    const content: NonNullable<Definition["content"]> = {
      subscribe: (listener) => {
        emitContent = listener
        return () => {
          contentClosed++
        }
      },
    }
    let unsubscribed = 0
    let mismatch = false
    const thread = { ref: input.ref, title: "Native task", state: "running" as const }
    const execution: NonNullable<Definition["execution"]> = {
      read: async (ref, page) => {
        calls.push({ ref, page })
        return {
          thread: { ...thread, ref: mismatch ? { ...ref, threadID: "other" } : ref },
          turn: { id: "native-turn", state: "running" },
          queue: [{ nativeID: "native-pending", inputID: "original-input", text: "Pending input", partial: false }],
          nextCursor: undefined,
          questions: [
            {
              id: "native-question",
              turnID: "native-turn",
              itemID: "native-item",
              blocking: true,
              state: "pending",
              prompts: [{ id: "choice", header: "Pick", question: "Which?", other: true, options: [] }],
              privatePayload: "must-stay-native",
            },
          ],
        }
      },
      subscribe: (listener) => {
        emit = listener
        return () => {
          unsubscribed++
        }
      },
    }
    const registered = yield* host.register({ ...example.backend, execution, content })
    const client = rpc.client(Api)
    const snapshot = yield* client.execution({ ref: input.ref, cursor: "native-cursor", limit: 1 })
    expect(snapshot.thread).toEqual(thread)
    expect(snapshot.queue[0].nativeID).toBe("native-pending")
    expect("nextCursor" in snapshot).toBe(false)
    expect(snapshot.questions?.[0]).toEqual({
      id: "native-question",
      turnID: "native-turn",
      itemID: "native-item",
      blocking: true,
      state: "pending",
      prompts: [{ id: "choice", header: "Pick", question: "Which?", other: true, options: [] }],
    })
    expect(calls).toEqual([{ ref: input.ref, page: { cursor: "native-cursor", limit: 1 } }])
    mismatch = true
    expect(Exit.isFailure(yield* client.execution({ ref: input.ref }).pipe(Effect.exit))).toBe(true)
    const observed = yield* client.events
      .subscribe("activity")
      .pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped({ startImmediately: true }))
    emit({ ref: { ...input.ref, backendID: "another" }, change: "execution" })
    emit({ ref: input.ref, change: "execution" })
    const old = emit
    const textEvents = yield* client.events
      .subscribe("content")
      .pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped({ startImmediately: true }))
    const frame: Content = {
      type: "append",
      ref: input.ref,
      streamID: "native-stream",
      turnID: "native-turn",
      itemID: "native-item",
      offset: 0,
      text: "prefix",
    }
    emitContent({ ...frame, ref: { ...input.ref, backendID: "other" } })
    emitContent(frame)
    const oldContent = emitContent
    yield* registered.dispose
    expect(unsubscribed).toBe(1)
    expect(contentClosed).toBe(1)
    yield* host.register({ ...example.backend, execution, content })
    oldContent({ ...frame, text: "stale-registration" })
    emitContent({ ...frame, offset: 6, text: "suffix" })
    old({ ref: input.ref, change: "both" })
    emit({ ref: input.ref, change: "history" })
    expect(Array.from(yield* Fiber.join(observed)).map((event) => event.data)).toEqual([
      { ref: input.ref, change: "execution" },
      { ref: input.ref, change: "history" },
    ])
    expect(example.admissions).toEqual([])
    expect(Array.from(yield* Fiber.join(textEvents)).map((event) => event.data)).toEqual([
      frame,
      { ...frame, offset: 6, text: "suffix" },
    ])
  }),
)

it.effect("native authentication uses scoped browser login and never exposes credential fields", () =>
  Effect.gen(function* () {
    const host = yield* ConversationBackend.Service
    const rpc = yield* Rpc.Service
    const calls: string[] = []
    yield* host.bind(rpc)
    const example = fixture()
    const registered = yield* host.register({
      ...example.backend,
      authentication: {
        read: async () => ({
          state: "signed-in",
          label: "fixture@example.test",
          plan: "fixture",
          accessToken: "must-stay-native",
        }),
        start: async () => {
          calls.push("start")
          return { id: "login-fixture", url: "https://auth.example.test/login", refreshToken: "must-stay-native" }
        },
        cancel: async (id) => {
          calls.push(id)
          return "not-found"
        },
        subscribe: () => () => {
          calls.push("unsubscribe")
        },
      },
    })
    const client = rpc.client(Api)
    expect(yield* client.status({ backendID: "example" })).toEqual({
      authentication: { state: "signed-in", label: "fixture@example.test", plan: "fixture" },
    })
    expect(yield* client.login({ backendID: "example" })).toEqual({
      id: "login-fixture",
      url: "https://auth.example.test/login",
    })
    expect(yield* client.cancelLogin({ backendID: "example", loginID: "only-this-attempt" })).toBe("not-found")
    yield* registered.dispose
    expect(Exit.isFailure(yield* client.status({ backendID: "example" }).pipe(Effect.exit))).toBe(true)
    expect(calls).toEqual(["start", "only-this-attempt", "unsubscribe"])
    expect(example.admissions).toEqual([])
  }),
)

it.effect("invalid browser destinations and account snapshots fail closed without replaying login", () =>
  Effect.gen(function* () {
    const host = yield* ConversationBackend.Service
    const rpc = yield* Rpc.Service
    yield* host.bind(rpc)
    let starts = 0
    yield* host.register({
      ...fixture().backend,
      authentication: {
        read: async () => {
          throw new Error("private native failure")
        },
        start: async () => {
          starts++
          return { id: "unsafe", url: "javascript:alert(1)" }
        },
        cancel: async () => "canceled",
        subscribe: () => () => {},
      },
    })
    const client = rpc.client(Api)
    expect(Exit.isFailure(yield* client.status({ backendID: "example" }).pipe(Effect.exit))).toBe(true)
    const result = yield* client.login({ backendID: "example" }).pipe(Effect.exit)
    expect(Exit.isFailure(result)).toBe(true)
    expect(JSON.stringify(result)).not.toContain("javascript:")
    expect(starts).toBe(1)
  }),
)

it.effect("concurrent copies admit once; retries use the durable receipt without retaining the text", () =>
  Effect.gen(function* () {
    const host = yield* ConversationBackend.Service
    const rpc = yield* Rpc.Service
    const kv = yield* KV.Service
    yield* host.bind(rpc)
    const example = fixture()
    yield* host.register(example.backend)
    const client = rpc.client(Api)
    const copies = yield* Effect.all(
      Array.from({ length: 8 }, () => client.send(input)),
      { concurrency: "unbounded" },
    )
    expect(copies.some((copy) => copy.status === "accepted")).toBe(true)
    expect(example.admissions).toHaveLength(1)
    const confirmed = yield* client.send(input)
    expect(confirmed.status).toBe("accepted")
    expect(example.admissions).toHaveLength(1)
    expect(JSON.stringify(yield* kv.scan({ prefix: "conversation:admission:" }))).not.toContain(input.text)
    expect(Exit.isFailure(yield* client.send({ ...input, text: "different" }).pipe(Effect.exit))).toBe(true)
    expect(
      Exit.isFailure(
        yield* client.send({ ...input, ref: { ...input.ref, threadID: "different-thread" } }).pipe(Effect.exit),
      ),
    ).toBe(true)
    expect(example.admissions).toHaveLength(1)
  }),
)

it.effect("a closed native connection unregisters itself without removing its replacement", () =>
  Effect.gen(function* () {
    const host = yield* ConversationBackend.Service
    const rpc = yield* Rpc.Service
    yield* host.bind(rpc)
    const example = fixture()
    let closed = () => {}
    const old = yield* host.register({
      ...example.backend,
      onClose: (listener) => {
        closed = listener
        return () => {}
      },
    })
    closed()
    expect(yield* rpc.client(Api).list({})).toEqual([])
    yield* host.register(example.backend)
    yield* old.dispose
    expect(yield* rpc.client(Api).list({})).toEqual([example.backend.descriptor])
    expect(example.closed()).toBe(1)
  }),
)

it.effect("lost acknowledgment reconciles native state and never resends", () =>
  Effect.gen(function* () {
    const host = yield* ConversationBackend.Service
    const rpc = yield* Rpc.Service
    yield* host.bind(rpc)
    const example = fixture()
    yield* host.register({
      ...example.backend,
      enqueue: async (request) => {
        await example.backend.enqueue(request)
        throw new Error("Native acknowledgment lost")
      },
    })
    const client = rpc.client(Api)
    expect((yield* client.send(input)).status).toBe("uncertain")
    expect((yield* client.send(input)).status).toBe("accepted")
    expect(example.admissions).toHaveLength(1)
  }),
)

it.effect("steering shares durable admission and cannot bypass it through the control method", () =>
  Effect.gen(function* () {
    const host = yield* ConversationBackend.Service
    const rpc = yield* Rpc.Service
    yield* host.bind(rpc)
    const example = fixture()
    let status: "applied" | "not-found" | "resolved" = "applied"
    let failing = false
    let decline = false
    let attempts = 0
    const controls: object[] = []
    const registered = yield* host.register({
      ...example.backend,
      enqueue: async (request) => {
        attempts++
        if (decline) return { status: "rejected", reason: "not-accepted" }
        return example.backend.enqueue(request)
      },
      control: async (request) => {
        controls.push(request)
        if (failing) throw new Error("Private native failure must not escape")
        return { status, privatePayload: "must-stay-native" }
      },
    })
    const client = rpc.client(Api)
    const withdrawal = {
      backendID: "example",
      control: { action: "withdraw" as const, threadID: "native-thread", nativeID: "native-pending" },
    }
    expect(yield* client.control(withdrawal)).toEqual({ status: "applied" })
    status = "not-found"
    expect(yield* client.control(withdrawal)).toEqual({ status: "not-found" })
    failing = true
    expect(Exit.isFailure(yield* client.control(withdrawal).pipe(Effect.exit))).toBe(true)
    expect(controls).toEqual([withdrawal.control, withdrawal.control, withdrawal.control])
    failing = false
    status = "resolved"
    const answer = {
      action: "answer" as const,
      threadID: "native-thread",
      questionID: "native-question",
      answers: { choice: ["Alpha"] },
    }
    expect(yield* client.control({ backendID: "example", control: answer })).toEqual({ status: "resolved" })
    expect(controls.at(-1)).toEqual(answer)
    expect(example.admissions).toEqual([])
    const steer = { ...input, delivery: "steer" as const, expectedTurnID: "active-native-turn" }
    yield* client.send(steer)
    yield* client.send(steer)
    expect(example.admissions).toEqual([steer])
    expect(Exit.isFailure(yield* client.send(input).pipe(Effect.exit))).toBe(true)
    expect(
      Exit.isFailure(
        yield* rpc
          .call(Api.id, "control", {
            backendID: "example",
            control: {
              action: "steer",
              threadID: "native-thread",
              turnID: "active-native-turn",
              inputID: "bypass",
              text: "bypass",
            },
          })
          .pipe(Effect.exit),
      ),
    ).toBe(true)
    expect(example.admissions).toHaveLength(1)
    decline = true
    const refused = { ...steer, inputID: "refused-guidance" }
    const rejection: Admission = {
      status: "rejected",
      reason: "not-accepted",
      ref: input.ref,
      inputID: refused.inputID,
    }
    expect(yield* client.send(refused)).toEqual(rejection)
    expect(yield* client.send(refused)).toEqual(rejection)
    expect(attempts).toBe(2)
    yield* registered.dispose
    yield* host.register(example.backend)
    expect(yield* client.send(refused)).toEqual(rejection)
    expect(example.admissions).toHaveLength(1)
  }),
)

it.effect("an interrupted unresolved handoff is not silently treated as unsent", () =>
  Effect.gen(function* () {
    const host = yield* ConversationBackend.Service
    const rpc = yield* Rpc.Service
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const runtime = yield* Effect.context<never>()
    const run = Effect.runPromiseWith(runtime)
    const example = fixture()
    yield* host.bind(rpc)
    yield* host.register({
      ...example.backend,
      enqueue: async (request) => {
        await run(Deferred.succeed(entered, undefined))
        await run(Deferred.await(release))
        return example.backend.enqueue(request)
      },
    })
    const client = rpc.client(Api)
    const pending = yield* client.send(input).pipe(Effect.forkChild({ startImmediately: true }))
    yield* Deferred.await(entered)
    yield* Fiber.interrupt(pending)
    expect((yield* client.send(input)).status).toBe("uncertain")
    expect(example.admissions).toHaveLength(0)
    // Promise-backed native work may finish after interruption; retain the admission fact.
    yield* Deferred.succeed(release, undefined)
  }),
)

it.effect("native acceptance followed by SQLite receipt failure does not report success or execute twice", () =>
  Effect.gen(function* () {
    const host = yield* ConversationBackend.Service
    const rpc = yield* Rpc.Service
    const db = (yield* Database.Service).db
    yield* host.bind(rpc)
    const example = fixture()
    yield* host.register(example.backend)
    const client = rpc.client(Api)
    yield* db.run(
      "CREATE TRIGGER reject_receipt BEFORE UPDATE ON kv BEGIN SELECT RAISE(ABORT, 'receipt fixture failure'); END",
    )
    const result = yield* client.send(input).pipe(Effect.exit, Effect.provideService(Logger.CurrentLoggers, new Set()))
    expect(Exit.isFailure(result)).toBe(true)
    expect(example.admissions).toHaveLength(1)
    yield* db.run("DROP TRIGGER reject_receipt")
    expect((yield* client.send(input)).status).toBe("accepted")
    expect(example.admissions).toHaveLength(1)
  }),
)
