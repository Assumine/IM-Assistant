import { expect } from "bun:test"
import { Effect, Layer, Deferred, Fiber, Exit, Logger } from "effect"
import type { Definition } from "@opencode/plugin/effect/conversation"
import { ConversationBackend } from "@opencode/core/conversation-backend"
import { Api, type Input, type Receipt } from "@opencode/schema/conversation-backend"
import { Database } from "@opencode/core/database/database"
import { KV } from "@opencode/core/kv"
import { Rpc } from "@opencode/core/rpc"
import { Location } from "@opencode/core/location"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { AbsolutePath } from "@opencode/core/schema"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([ConversationBackend.node, Rpc.node, KV.node, Database.node]), [
  Location.node.replace(Layer.succeed(Location.Service, location({ directory: AbsolutePath.make("/backend-test") }))),
]))

function fixture() {
  const admissions: Input[] = []
  const receipts = new Map<string, Receipt>()
  let closed = 0
  const backend: Definition = {
    descriptor: { id: "example", label: "Example native backend" },
    create: async () => ({ nativeThread: "native-thread" }),
    query: async () => ({ nativeHistory: [] }),
    control: async () => ({}),
    enqueue: async (input) => {
      admissions.push(input)
      const receipt = { nativeID: `native-${admissions.length}`, kind: "queued" as const }
      receipts.set(input.inputID, receipt)
      return receipt
    },
    reconcile: async (_ref, id) => receipts.get(id),
    subscribe: () => () => { closed++ },
  }
  return { backend, admissions, receipts, closed: () => closed }
}
const input = { ref: { backendID: "example", threadID: "native-thread" }, inputID: "input-1", text: "private-input-not-stored-in-receipts" }

it.effect("public native RPC is optional, and backend registration is scoped and unique", () => Effect.gen(function* () {
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
  expect(Exit.isFailure(yield* host.register(example.backend).pipe(Effect.exit))).toBe(true)
  yield* registered.dispose
  yield* registered.dispose
  expect(example.closed()).toBe(1)
  expect(yield* client.list({})).toEqual([])
}))

it.effect("concurrent copies admit once; retries use the durable receipt without retaining the text", () => Effect.gen(function* () {
  const host = yield* ConversationBackend.Service
  const rpc = yield* Rpc.Service
  const kv = yield* KV.Service
  yield* host.bind(rpc)
  const example = fixture()
  yield* host.register(example.backend)
  const client = rpc.client(Api)
  const copies = yield* Effect.all(Array.from({ length: 8 }, () => client.send(input)), { concurrency: "unbounded" })
  expect(copies.some((copy) => copy.status === "accepted")).toBe(true)
  expect(example.admissions).toHaveLength(1)
  const confirmed = yield* client.send(input)
  expect(confirmed.status).toBe("accepted")
  expect(example.admissions).toHaveLength(1)
  expect(JSON.stringify(yield* kv.scan({ prefix: "conversation:admission:" }))).not.toContain(input.text)
  expect(Exit.isFailure(yield* client.send({ ...input, text: "different" }).pipe(Effect.exit))).toBe(true)
  expect(Exit.isFailure(yield* client.send({ ...input, ref: { ...input.ref, threadID: "different-thread" } }).pipe(Effect.exit))).toBe(true)
  expect(example.admissions).toHaveLength(1)
}))

it.effect("a closed native connection unregisters itself without removing its replacement", () => Effect.gen(function* () {
  const host = yield* ConversationBackend.Service
  const rpc = yield* Rpc.Service
  yield* host.bind(rpc)
  const example = fixture()
  let closed = () => {}
  const old = yield* host.register({ ...example.backend, onClose: (listener) => { closed = listener; return () => {} } })
  closed()
  expect(yield* rpc.client(Api).list({})).toEqual([])
  yield* host.register(example.backend)
  yield* old.dispose
  expect(yield* rpc.client(Api).list({})).toEqual([example.backend.descriptor])
  expect(example.closed()).toBe(1)
}))

it.effect("lost acknowledgment reconciles native state and never resends", () => Effect.gen(function* () {
  const host = yield* ConversationBackend.Service
  const rpc = yield* Rpc.Service
  yield* host.bind(rpc)
  const example = fixture()
  yield* host.register({ ...example.backend, enqueue: async (request) => {
    await example.backend.enqueue(request)
    throw new Error("Native acknowledgment lost")
  } })
  const client = rpc.client(Api)
  expect((yield* client.send(input)).status).toBe("uncertain")
  expect((yield* client.send(input)).status).toBe("accepted")
  expect(example.admissions).toHaveLength(1)
}))

it.effect("steering shares durable admission and cannot bypass it through the control method", () => Effect.gen(function* () {
  const host = yield* ConversationBackend.Service
  const rpc = yield* Rpc.Service
  yield* host.bind(rpc)
  const example = fixture()
  yield* host.register(example.backend)
  const client = rpc.client(Api)
  const steer = { ...input, delivery: "steer" as const, expectedTurnID: "active-native-turn" }
  yield* client.send(steer)
  yield* client.send(steer)
  expect(example.admissions).toEqual([steer])
  expect(Exit.isFailure(yield* client.send(input).pipe(Effect.exit))).toBe(true)
  expect(Exit.isFailure(yield* rpc.call(Api.id, "control", {
    backendID: "example", control: { action: "steer", threadID: "native-thread", turnID: "active-native-turn", inputID: "bypass", text: "bypass" },
  }).pipe(Effect.exit))).toBe(true)
  expect(example.admissions).toHaveLength(1)
}))

it.effect("an interrupted unresolved handoff is not silently treated as unsent", () => Effect.gen(function* () {
  const host = yield* ConversationBackend.Service
  const rpc = yield* Rpc.Service
  const entered = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const runtime = yield* Effect.context<never>()
  const run = Effect.runPromiseWith(runtime)
  const example = fixture()
  yield* host.bind(rpc)
  yield* host.register({ ...example.backend, enqueue: async (request) => {
    await run(Deferred.succeed(entered, undefined))
    await run(Deferred.await(release))
    return example.backend.enqueue(request)
  } })
  const client = rpc.client(Api)
  const pending = yield* client.send(input).pipe(Effect.forkChild({ startImmediately: true }))
  yield* Deferred.await(entered)
  yield* Fiber.interrupt(pending)
  expect((yield* client.send(input)).status).toBe("uncertain")
  expect(example.admissions).toHaveLength(0)
  // Promise-backed native work may finish after interruption; retain the admission fact.
  yield* Deferred.succeed(release, undefined)
}))

it.effect("native acceptance followed by SQLite receipt failure does not report success or execute twice", () => Effect.gen(function* () {
  const host = yield* ConversationBackend.Service
  const rpc = yield* Rpc.Service
  const db = (yield* Database.Service).db
  yield* host.bind(rpc)
  const example = fixture()
  yield* host.register(example.backend)
  const client = rpc.client(Api)
  yield* db.run("CREATE TRIGGER reject_receipt BEFORE UPDATE ON kv BEGIN SELECT RAISE(ABORT, 'receipt fixture failure'); END")
  const result = yield* client.send(input).pipe(Effect.exit, Effect.provideService(Logger.CurrentLoggers, new Set()))
  expect(Exit.isFailure(result)).toBe(true)
  expect(example.admissions).toHaveLength(1)
  yield* db.run("DROP TRIGGER reject_receipt")
  expect((yield* client.send(input)).status).toBe("accepted")
  expect(example.admissions).toHaveLength(1)
}))
