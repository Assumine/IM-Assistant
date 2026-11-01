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
  type Output,
} from "@opencode/schema/conversation-backend"
import { Database } from "@opencode/core/database/database"
import { KV } from "@opencode/core/kv"
import { Rpc } from "@opencode/core/rpc"
import { Location } from "@opencode/core/location"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { AbsolutePath } from "@opencode/core/schema"
import { Hash } from "@opencode/util/hash"
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
    create: async () => ({
      thread: { ref: { backendID: "example", threadID: "native-thread" }, title: "New native thread", state: "idle" },
      privateHome: "must-stay-native",
    }),
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

it.effect("native public output is optional, read-only, schema-filtered and fenced to the registered input owner", () =>
  Effect.gen(function* () {
    const host = yield* ConversationBackend.Service,
      rpc = yield* Rpc.Service,
      kv = yield* KV.Service
    yield* host.bind(rpc)
    const example = fixture(),
      client = rpc.client(Api)
    const missing = yield* host.register(example.backend)
    expect(Exit.isFailure(yield* client.output(input).pipe(Effect.exit))).toBe(true)
    yield* missing.dispose
    let output: Output = {
      ref: input.ref,
      inputID: input.inputID,
      rootID: input.inputID,
      turnID: "native-turn",
      status: "closed",
      state: "completed",
      last: { messageID: "native-item", text: "Public result", settled: true },
    }
    yield* host.register({
      ...example.backend,
      output: async () => ({ ...output, privateContext: "must-stay-native" }),
    })
    const result = yield* client.output(input)
    expect(result).toEqual(output)
    expect(JSON.stringify(result)).not.toContain("must-stay-native")
    output = { ...output, ref: { ...input.ref, threadID: "foreign-thread" } }
    expect(Exit.isFailure(yield* client.output(input).pipe(Effect.exit))).toBe(true)
    expect(example.admissions).toEqual([])
    expect((yield* kv.scan({ prefix: "conversation:admission:" })).entries).toEqual([])
  }),
)

it.effect("linked native admission requires whole-backend support and retains an immutable parent across retries", () =>
  Effect.gen(function* () {
    const host = yield* ConversationBackend.Service,
      rpc = yield* Rpc.Service,
      kv = yield* KV.Service
    yield* host.bind(rpc)
    const client = rpc.client(Api),
      example = fixture()
    const request = {
      ...input,
      followupOf: { inputID: "parent-input", turnID: "ended-turn", nativeID: "native-parent" },
    }
    const missing = yield* host.register(example.backend)
    expect(Exit.isFailure(yield* client.send(request).pipe(Effect.exit))).toBe(true)
    expect((yield* kv.scan({ prefix: "conversation:admission:" })).entries).toHaveLength(0)
    yield* missing.dispose
    const calls: object[] = []
    const registered = yield* host.register({
      ...example.backend,
      followup: async (next) => {
        calls.push(next)
        return { nativeID: "child-native", kind: "queued" }
      },
    })
    // Persisted pre-follow-up format: its fingerprint contains the original four fields only.
    yield* kv.insert(`conversation:admission:${Hash.sha256("legacy-plain")}`, {
      ref: input.ref,
      inputID: "legacy-plain",
      fingerprint: "21bb3db13d4f988435a98a19195190cf51c2537d379cda817f4e6757dfb14d09",
      receipt: { nativeID: "legacy-native", kind: "queued" },
    })
    expect(yield* client.send({ ...input, inputID: "legacy-plain" })).toEqual({
      status: "accepted",
      ref: input.ref,
      inputID: "legacy-plain",
      receipt: { nativeID: "legacy-native", kind: "queued" },
    })
    const admitted = yield* client.send(request)
    expect(admitted).toEqual({
      ref: input.ref,
      inputID: input.inputID,
      followupOf: request.followupOf,
      status: "accepted",
      receipt: { nativeID: "child-native", kind: "queued" },
    })
    expect(yield* client.send(request)).toEqual(admitted)
    expect(
      Exit.isFailure(
        yield* client
          .send({ ...request, followupOf: { ...request.followupOf, turnID: "different" } })
          .pipe(Effect.exit),
      ),
    ).toBe(true)
    expect(Exit.isFailure(yield* client.send(input).pipe(Effect.exit))).toBe(true)
    expect(calls).toHaveLength(1)
    expect(example.admissions).toHaveLength(0)
    yield* registered.dispose
    expect(yield* client.reconcile(request)).toEqual(admitted)
  }),
)

it.effect("native follow-up lost acknowledgments repair only the original relation and never resend", () =>
  Effect.gen(function* () {
    const host = yield* ConversationBackend.Service,
      rpc = yield* Rpc.Service
    yield* host.bind(rpc)
    const example = fixture(),
      request = { ...input, followupOf: { inputID: "parent-input", turnID: "parent-turn", nativeID: "parent-native" } }
    let calls = 0
    yield* host.register({
      ...example.backend,
      followup: async (next) => {
        calls++
        example.receipts.set(next.inputID, { nativeID: "new-native", kind: "queued" })
        throw new Error("Native acknowledgment lost")
      },
    })
    const client = rpc.client(Api)
    expect(yield* client.send(request)).toEqual({
      status: "uncertain",
      ref: input.ref,
      inputID: input.inputID,
      followupOf: request.followupOf,
    })
    expect(yield* client.reconcile(request)).toEqual({
      status: "accepted",
      ref: input.ref,
      inputID: input.inputID,
      followupOf: request.followupOf,
      receipt: { nativeID: "new-native", kind: "queued" },
    })
    expect((yield* client.send(request)).status).toBe("accepted")
    expect(calls).toBe(1)
    expect(example.admissions).toEqual([])
  }),
)

it.effect("native input lookup is fresh, read-only and independent of cached queue admissions", () =>
  Effect.gen(function* () {
    const host = yield* ConversationBackend.Service
    const rpc = yield* Rpc.Service
    const kv = yield* KV.Service
    const example = fixture()
    let delivered = false
    yield* host.bind(rpc)
    yield* host.register({
      ...example.backend,
      input: async (ref, inputID) =>
        inputID === "unknown"
          ? { ref, inputID, status: "unknown", privateBody: "not-public" }
          : delivered
            ? { ref, inputID, status: "delivered", nativeID: "message", turnID: "original-turn" }
            : { ref, inputID, status: "queued", nativeID: "pending" },
    })
    const client = rpc.client(Api)
    expect(yield* client.input({ ref: input.ref, inputID: "unknown" })).toEqual({
      ref: input.ref,
      inputID: "unknown",
      status: "unknown",
    })
    expect((yield* kv.scan({ prefix: "conversation:admission:" })).entries).toEqual([])
    const admitted = yield* client.send(input)
    expect((yield* client.input({ ref: input.ref, inputID: input.inputID })).status).toBe("queued")
    delivered = true
    expect(yield* client.reconcile(input)).toEqual(admitted)
    expect(yield* client.input(input)).toEqual({
      ref: input.ref,
      inputID: input.inputID,
      status: "delivered",
      nativeID: "message",
      turnID: "original-turn",
    })
    expect(example.admissions).toHaveLength(1)
  }),
)

it.effect("input lookup refuses missing capability, wrong identity and a replaced registration", () =>
  Effect.gen(function* () {
    const host = yield* ConversationBackend.Service
    const rpc = yield* Rpc.Service
    const example = fixture()
    yield* host.bind(rpc)
    const client = rpc.client(Api)
    const missing = yield* host.register(example.backend)
    expect(Exit.isFailure(yield* client.input(input).pipe(Effect.exit))).toBe(true)
    yield* missing.dispose
    for (const identity of [
      { ref: { ...input.ref, threadID: "other" }, inputID: input.inputID },
      { ref: input.ref, inputID: "other-input" },
    ]) {
      const wrong = yield* host.register({
        ...example.backend,
        input: async () => ({ ...identity, status: "unknown" }),
      })
      expect(Exit.isFailure(yield* client.input(input).pipe(Effect.exit))).toBe(true)
      yield* wrong.dispose
    }
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const run = Effect.runPromiseWith(yield* Effect.context<never>())
    const original = yield* host.register({
      ...example.backend,
      input: async (ref, inputID) => {
        await run(Deferred.succeed(entered, undefined))
        await run(Deferred.await(release))
        return { ref, inputID, status: "delivered", nativeID: "message", turnID: "old-turn" }
      },
    })
    const request = yield* client.input(input).pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
    yield* Deferred.await(entered)
    yield* original.dispose
    yield* host.register(fixture().backend)
    yield* Deferred.succeed(release, undefined)
    expect(Exit.isFailure(yield* Fiber.join(request))).toBe(true)
    expect(example.admissions).toEqual([])
  }),
)

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
    expect(yield* client.create({ backendID: "example" })).toEqual({
      thread: { ref: input.ref, title: "New native thread", state: "idle" },
    })
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

it.effect("native creation rejects another owner and a replaced registration without replay", () =>
  Effect.gen(function* () {
    const host = yield* ConversationBackend.Service
    const rpc = yield* Rpc.Service
    const example = fixture()
    yield* host.bind(rpc)
    const client = rpc.client(Api)
    const wrong = yield* host.register({
      ...example.backend,
      create: async () => ({
        thread: { ref: { ...input.ref, backendID: "other" }, title: "Wrong owner", state: "idle" },
      }),
    })
    expect(Exit.isFailure(yield* client.create({ backendID: "example" }).pipe(Effect.exit))).toBe(true)
    yield* wrong.dispose
    const entered = yield* Deferred.make<void>()
    const released = yield* Deferred.make<void>()
    const run = Effect.runPromiseWith(yield* Effect.context<never>())
    let calls = 0
    const original = yield* host.register({
      ...example.backend,
      create: async () => {
        calls++
        await run(Deferred.succeed(entered, undefined))
        await run(Deferred.await(released))
        return example.backend.create()
      },
    })
    const pending = yield* client
      .create({ backendID: "example" })
      .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
    yield* Deferred.await(entered)
    yield* original.dispose
    yield* host.register({ ...fixture().backend })
    yield* Deferred.succeed(released, undefined)
    expect(Exit.isFailure(yield* Fiber.join(pending))).toBe(true)
    expect(calls).toBe(1)
    expect(example.admissions).toEqual([])
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

it.effect("receipt-only reconciliation never creates an admission and keeps cached receipts across disconnection", () =>
  Effect.gen(function* () {
    const host = yield* ConversationBackend.Service
    const rpc = yield* Rpc.Service
    const kv = yield* KV.Service
    yield* host.bind(rpc)
    const client = rpc.client(Api)
    const request = { ref: input.ref, inputID: input.inputID }
    expect(yield* client.reconcile(request)).toEqual({ ...request, status: "uncertain" })
    expect((yield* kv.scan({ prefix: "conversation:admission:" })).entries).toHaveLength(0)
    const example = fixture()
    const registered = yield* host.register(example.backend)
    expect((yield* client.reconcile(request)).status).toBe("uncertain")
    expect(example.admissions).toEqual([])
    const admitted = yield* client.send(input)
    expect(yield* client.reconcile(request)).toEqual(admitted)
    expect(
      Exit.isFailure(
        yield* client.reconcile({ ...request, ref: { ...input.ref, threadID: "other" } }).pipe(Effect.exit),
      ),
    ).toBe(true)
    yield* registered.dispose
    expect(yield* client.reconcile(request)).toEqual(admitted)
    expect(example.admissions).toHaveLength(1)
  }),
)

it.effect("receipt-only reconciliation repairs lost acknowledgments and retains definitive refusal", () =>
  Effect.gen(function* () {
    const host = yield* ConversationBackend.Service
    const rpc = yield* Rpc.Service
    yield* host.bind(rpc)
    const example = fixture()
    yield* host.register({
      ...example.backend,
      enqueue: async (request) => {
        if (request.inputID === "refused") return { status: "rejected", reason: "not-accepted" }
        await example.backend.enqueue(request)
        throw new Error("Lost acknowledgment")
      },
    })
    const client = rpc.client(Api)
    expect((yield* client.send(input)).status).toBe("uncertain")
    const request = { ref: input.ref, inputID: input.inputID }
    const recovered = yield* client.reconcile(request)
    expect(recovered.status).toBe("accepted")
    example.receipts.clear()
    expect(yield* client.reconcile(request)).toEqual(recovered)
    const refused = yield* client.send({ ...input, inputID: "refused" })
    expect(yield* client.reconcile({ ...request, inputID: "refused" })).toEqual(refused)
    expect(example.admissions).toHaveLength(1)
  }),
)

it.effect("receipt-only reconciliation cannot confirm a result from a replaced native connection", () =>
  Effect.gen(function* () {
    const host = yield* ConversationBackend.Service
    const rpc = yield* Rpc.Service
    yield* host.bind(rpc)
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const run = Effect.runPromiseWith(yield* Effect.context<never>())
    const example = fixture()
    const registered = yield* host.register({
      ...example.backend,
      enqueue: async () => {
        throw new Error("Unknown")
      },
      reconcile: async () => {
        await run(Deferred.succeed(entered, undefined))
        await run(Deferred.await(release))
        return { nativeID: "stale", kind: "queued" }
      },
    })
    const client = rpc.client(Api)
    expect((yield* client.send(input)).status).toBe("uncertain")
    const pending = yield* client
      .reconcile({ ref: input.ref, inputID: input.inputID })
      .pipe(Effect.forkChild({ startImmediately: true }))
    yield* Deferred.await(entered)
    yield* registered.dispose
    yield* host.register(example.backend)
    yield* Deferred.succeed(release, undefined)
    expect((yield* Fiber.join(pending)).status).toBe("uncertain")
    expect(example.admissions).toEqual([])
  }),
)
