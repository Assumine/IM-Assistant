export * as ConversationBackend from "./conversation-backend.js"

import { Context, Effect, Layer, Schema, Scope } from "effect"
import type { Definition, ConversationDomain } from "@opencode/plugin/effect/conversation"
import { ConversationBackend } from "@opencode/schema/conversation-backend"
import { Hash } from "@opencode/util/hash"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { KV } from "./kv.js"
import type { Rpc } from "./rpc.js"

const Stored = Schema.Struct({
  ref: ConversationBackend.Ref, inputID: Schema.String, fingerprint: Schema.String,
  receipt: Schema.optional(ConversationBackend.Receipt),
})

interface Interface extends ConversationDomain {
  readonly bind: (rpc: Rpc.Interface) => Effect.Effect<void, unknown, Scope.Scope>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/ConversationBackend") {}

const layer = Layer.effect(Service, Effect.gen(function* () {
  const kv = yield* KV.Service
  const backends = new Map<string, Definition>()
  const listeners = new Set<(backendID: string, notification: Schema.Json) => void>()
  const register: ConversationDomain["register"] = Effect.fn("ConversationBackend.register")(function* (backend) {
    const descriptor = yield* Schema.decodeUnknownEffect(ConversationBackend.Descriptor)(backend.descriptor)
    if (descriptor.id === "opencode" || backends.has(descriptor.id)) return yield* Effect.fail(new Error("Backend ID is already registered or reserved"))
    const unsubscribe = backend.subscribe((notification) => {
      for (const listener of listeners) listener(descriptor.id, notification)
    })
    const dispose = Effect.sync(() => {
      if (backends.get(descriptor.id) !== backend) return
      backends.delete(descriptor.id)
      unsubscribe()
    })
    yield* Effect.acquireRelease(Effect.sync(() => backends.set(descriptor.id, backend)), () => dispose)
    return { dispose }
  })

  const bind = Effect.fn("ConversationBackend.bind")(function* (rpc: Rpc.Interface) {
    const get = (id: string) => backends.get(id)
    const registration = yield* rpc.register(ConversationBackend.Api, {
      list: () => Effect.sync(() => Array.from(backends.values(), (backend) => backend.descriptor)),
      create: (input, ctx) => {
        const backend = get(input.backendID)
        if (!backend) return Effect.fail(ctx.error("unavailable", "Conversation backend is unavailable"))
        return Effect.tryPromise({ try: () => backend.create(), catch: () => ctx.error("failed", "Native backend request failed") })
      },
      query: (input, ctx) => {
        const backend = get(input.backendID)
        if (!backend) return Effect.fail(ctx.error("unavailable", "Conversation backend is unavailable"))
        return Effect.tryPromise({ try: () => backend.query(input.query), catch: () => ctx.error("failed", "Native backend request failed") })
      },
      control: (input, ctx) => {
        const backend = get(input.backendID)
        if (!backend) return Effect.fail(ctx.error("unavailable", "Conversation backend is unavailable"))
        return Effect.tryPromise({ try: () => backend.control(input.control), catch: () => ctx.error("failed", "Control result unknown; reconcile native state before retrying") })
      },
      send: (input, ctx) => Effect.gen(function* () {
        const key = `conversation:admission:${Hash.sha256(input.inputID)}`
        const fingerprint = Hash.sha256(JSON.stringify([
          input.ref.backendID, input.ref.threadID, input.text,
          input.delivery === "steer" ? input.expectedTurnID : null,
        ]))
        const stored = { ref: input.ref, inputID: input.inputID, fingerprint }
        const backend = get(input.ref.backendID)
        if (!backend) return yield* Effect.fail(ctx.error("unavailable", "Conversation backend is unavailable"))
        // A native SQLite first-writer fact, not a second pending-work queue. No payload is stored.
        const first = yield* kv.insert(key, stored)
        const current = first ? stored : yield* kv.get(key).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Stored)), Effect.orDie,
        )
        if (current.fingerprint !== fingerprint || current.ref.backendID !== input.ref.backendID || current.ref.threadID !== input.ref.threadID) {
          return yield* Effect.fail(ctx.error("conflict", "Input ID belongs to a different request"))
        }
        if ("receipt" in current && current.receipt) return { status: "accepted" as const, ref: input.ref, inputID: input.inputID, receipt: current.receipt }
        // An interrupted or concurrent request is never sent again. Only native state can confirm delivery.
        const result = yield* Effect.tryPromise({
          try: () => first ? backend.enqueue(input) : backend.reconcile(input.ref, input.inputID),
          catch: () => undefined,
        }).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!result) return { status: "uncertain" as const, ref: input.ref, inputID: input.inputID }
        const receipt = yield* Schema.decodeUnknownEffect(ConversationBackend.Receipt)(result).pipe(Effect.orDie)
        yield* kv.set(key, { ...stored, receipt })
        return { status: "accepted" as const, ref: input.ref, inputID: input.inputID, receipt }
      }),
    })
    const runtime = yield* Effect.context<Scope.Scope>()
    const run = Effect.runPromiseWith(runtime)
    const listener = (backendID: string, notification: Schema.Json) => {
      void run(registration.events.emit("notification", { backendID, notification })).catch(() => undefined)
    }
    listeners.add(listener)
    yield* Effect.addFinalizer(() => Effect.sync(() => { listeners.delete(listener) }))
  })
  return Service.of({ register, bind })
}))

export const node = makeGlobalNode({ service: Service, layer, deps: [KV.node] })
