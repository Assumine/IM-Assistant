export * as ConversationBackend from "./conversation-backend.js"

import { Context, Effect, Layer, Schema, Scope } from "effect"
import type { Definition, ConversationDomain } from "@opencode/plugin/effect/conversation"
import { ConversationBackend } from "@opencode/schema/conversation-backend"
import { Hash } from "@opencode/util/hash"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { KV } from "./kv.js"
import type { Rpc } from "./rpc.js"

const Stored = Schema.Struct({
  ref: ConversationBackend.Ref,
  inputID: Schema.String,
  fingerprint: Schema.String,
  receipt: Schema.optional(ConversationBackend.Receipt),
  rejection: Schema.optional(ConversationBackend.Rejection),
  followupOf: Schema.optional(ConversationBackend.ParentInput),
})

interface Interface extends ConversationDomain {
  readonly bind: (rpc: Rpc.Interface) => Effect.Effect<void, unknown, Scope.Scope>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/ConversationBackend") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const kv = yield* KV.Service
    const backends = new Map<string, Definition>()
    const listeners = new Set<(backendID: string, notification: Schema.Json) => void>()
    const changed = new Set<() => void>()
    const authentication = new Set<(backendID: string, event: ConversationBackend.AuthenticationEvent) => void>()
    const activity = new Set<(event: ConversationBackend.Activity) => void>()
    const content = new Set<(event: ConversationBackend.Content) => void>()
    const register: ConversationDomain["register"] = Effect.fn("ConversationBackend.register")(function* (backend) {
      const descriptor = yield* Schema.decodeUnknownEffect(Schema.toType(ConversationBackend.Descriptor))(
        backend.descriptor,
      )
      if (descriptor.id === "opencode" || backends.has(descriptor.id))
        return yield* Effect.fail(new Error("Backend ID is already registered or reserved"))
      const unsubscribe = backend.subscribe((notification) => {
        for (const listener of listeners) listener(descriptor.id, notification)
      })
      const unsubscribeAuthentication =
        backend.authentication?.subscribe((event) => {
          for (const listener of authentication) listener(descriptor.id, event)
        }) ?? (() => {})
      let stopped = false
      const unsubscribeContent =
        backend.content?.subscribe((event) => {
          if (stopped || backends.get(descriptor.id) !== backend) return
          let decoded: ConversationBackend.Content
          try {
            decoded = Schema.decodeUnknownSync(Schema.toType(ConversationBackend.Content))(event)
          } catch {
            return
          }
          if (decoded.ref.backendID !== descriptor.id) return
          for (const listener of content) listener(decoded)
        }) ?? (() => {})
      const unsubscribeActivity =
        backend.execution?.subscribe((event) => {
          if (stopped || backends.get(descriptor.id) !== backend) return
          let decoded: ConversationBackend.Activity
          try {
            decoded = Schema.decodeUnknownSync(Schema.toType(ConversationBackend.Activity))(event)
          } catch {
            return
          }
          if (decoded.ref.backendID !== descriptor.id) return
          for (const listener of activity) listener(decoded)
        }) ?? (() => {})
      let unsubscribeClose = () => {}
      const remove = () => {
        if (stopped) return
        stopped = true
        if (backends.get(descriptor.id) === backend) {
          backends.delete(descriptor.id)
          for (const listener of changed) listener()
        }
        unsubscribe()
        unsubscribeAuthentication()
        unsubscribeActivity()
        unsubscribeContent()
        unsubscribeClose()
      }
      const dispose = Effect.sync(remove)
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          backends.set(descriptor.id, backend)
          for (const listener of changed) listener()
          unsubscribeClose = backend.onClose?.(remove) ?? (() => {})
        }),
        () => dispose,
      )
      return { dispose }
    })

    const bind = Effect.fn("ConversationBackend.bind")(function* (rpc: Rpc.Interface) {
      const get = (id: string) => backends.get(id)
      const registration = yield* rpc.register(ConversationBackend.Api, {
        list: () => Effect.sync(() => Array.from(backends.values(), (backend) => backend.descriptor)),
        threads: (input, ctx) => {
          const browse = get(input.backendID)?.browse
          if (!browse) return Effect.fail(ctx.error("unavailable", "Backend history is unavailable"))
          return Effect.tryPromise({
            try: () => browse.threads({ cursor: input.cursor, limit: input.limit }),
            catch: () => ctx.error("failed", "Unable to read backend conversations"),
          }).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.toType(ConversationBackend.Threads))),
            Effect.flatMap((page) =>
              page.items.every((item) => item.ref.backendID === input.backendID)
                ? Effect.succeed(page)
                : Effect.fail(ctx.error("failed", "Backend returned a different conversation owner")),
            ),
            Effect.mapError(() => ctx.error("failed", "Unable to read backend conversations")),
          )
        },
        history: (input, ctx) => {
          const browse = get(input.ref.backendID)?.browse
          if (!browse) return Effect.fail(ctx.error("unavailable", "Backend history is unavailable"))
          return Effect.tryPromise({
            try: () => browse.history(input.ref, { cursor: input.cursor, limit: input.limit }),
            catch: () => ctx.error("failed", "Unable to read backend history"),
          }).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.toType(ConversationBackend.History))),
            Effect.flatMap((page) =>
              page.thread.ref.backendID === input.ref.backendID && page.thread.ref.threadID === input.ref.threadID
                ? Effect.succeed(page)
                : Effect.fail(ctx.error("failed", "Backend returned a different conversation")),
            ),
            Effect.mapError(() => ctx.error("failed", "Unable to read backend history")),
          )
        },
        execution: (input, ctx) => {
          const execution = get(input.ref.backendID)?.execution
          if (!execution) return Effect.fail(ctx.error("unavailable", "Backend execution is unavailable"))
          return Effect.tryPromise({
            try: () => execution.read(input.ref, { cursor: input.cursor, limit: input.limit }),
            catch: () => ctx.error("failed", "Unable to read backend execution"),
          }).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.toType(ConversationBackend.Execution))),
            Effect.flatMap((snapshot) =>
              snapshot.thread.ref.backendID === input.ref.backendID &&
              snapshot.thread.ref.threadID === input.ref.threadID
                ? Effect.succeed(snapshot)
                : Effect.fail(ctx.error("failed", "Backend returned a different conversation")),
            ),
            Effect.mapError(() => ctx.error("failed", "Unable to read backend execution")),
          )
        },
        status: (input, ctx) => {
          const backend = get(input.backendID)
          if (!backend) return Effect.fail(ctx.error("unavailable", "Conversation backend is unavailable"))
          const auth = backend.authentication
          if (!auth) return Effect.succeed({ authentication: null })
          return Effect.tryPromise({
            try: () => auth.read(),
            catch: () => ctx.error("failed", "Unable to read backend account"),
          }).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.toType(ConversationBackend.Account))),
            Effect.map((account) => ({ authentication: account })),
            Effect.mapError(() => ctx.error("failed", "Unable to read backend account")),
          )
        },
        login: (input, ctx) => {
          const auth = get(input.backendID)?.authentication
          if (!auth) return Effect.fail(ctx.error("unavailable", "Backend sign-in is unavailable"))
          return Effect.tryPromise({
            try: () => auth.start(),
            catch: () => ctx.error("failed", "Unable to confirm sign-in request"),
          }).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(ConversationBackend.BrowserLogin)),
            Effect.mapError(() => ctx.error("failed", "Unable to confirm sign-in request")),
          )
        },
        cancelLogin: (input, ctx) => {
          const auth = get(input.backendID)?.authentication
          if (!auth) return Effect.fail(ctx.error("unavailable", "Backend sign-in is unavailable"))
          return Effect.tryPromise({
            try: () => auth.cancel(input.loginID),
            catch: () => ctx.error("failed", "Unable to confirm sign-in cancellation"),
          })
        },
        create: (input, ctx) => {
          const backend = get(input.backendID)
          if (!backend) return Effect.fail(ctx.error("unavailable", "Conversation backend is unavailable"))
          return Effect.tryPromise({
            try: () => backend.create(),
            catch: () => ctx.error("failed", "Native backend request failed"),
          }).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.toType(ConversationBackend.Created))),
            Effect.flatMap((created) =>
              created.thread.ref.backendID === input.backendID && get(input.backendID) === backend
                ? Effect.succeed(created)
                : Effect.fail(ctx.error("failed", "Native creation could not be confirmed")),
            ),
            Effect.mapError(() => ctx.error("failed", "Native creation could not be confirmed")),
          )
        },
        query: (input, ctx) => {
          const backend = get(input.backendID)
          if (!backend) return Effect.fail(ctx.error("unavailable", "Conversation backend is unavailable"))
          return Effect.tryPromise({
            try: () => backend.query(input.query),
            catch: () => ctx.error("failed", "Native backend request failed"),
          })
        },
        control: (input, ctx) => {
          const backend = get(input.backendID)
          if (!backend) return Effect.fail(ctx.error("unavailable", "Conversation backend is unavailable"))
          return Effect.tryPromise({
            try: async () =>
              Schema.decodeUnknownSync(Schema.toType(ConversationBackend.ControlResult))(
                await backend.control(input.control),
              ),
            catch: () => ctx.error("failed", "Control result unknown; reconcile native state before retrying"),
          })
        },
        input: (input, ctx) => {
          const backend = get(input.ref.backendID)
          if (!backend?.input) return Effect.fail(ctx.error("unavailable", "Backend input identity is unavailable"))
          return Effect.tryPromise({
            try: () => backend.input!(input.ref, input.inputID),
            catch: () => ctx.error("failed", "Unable to locate backend input"),
          }).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.toType(ConversationBackend.InputPosition))),
            Effect.flatMap((position) =>
              get(input.ref.backendID) === backend &&
              position.inputID === input.inputID &&
              position.ref.backendID === input.ref.backendID &&
              position.ref.threadID === input.ref.threadID
                ? Effect.succeed(position)
                : Effect.fail(ctx.error("failed", "Backend returned a different input owner")),
            ),
            Effect.mapError(() => ctx.error("failed", "Unable to locate backend input")),
          )
        },
        output: (input, ctx) => {
          const backend = get(input.ref.backendID)
          if (!backend?.output)
            return Effect.fail(ctx.error("unavailable", "Backend output attribution is unavailable"))
          return Effect.tryPromise({
            try: () => backend.output!(input.ref, input.inputID),
            catch: () => ctx.error("failed", "Unable to read backend output"),
          }).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.toType(ConversationBackend.Output))),
            Effect.flatMap((output) =>
              get(input.ref.backendID) === backend &&
              output.inputID === input.inputID &&
              output.ref.backendID === input.ref.backendID &&
              output.ref.threadID === input.ref.threadID
                ? Effect.succeed(output)
                : Effect.fail(ctx.error("failed", "Backend returned a different output owner")),
            ),
            Effect.mapError(() => ctx.error("failed", "Unable to read backend output")),
          )
        },
        reconcile: (input, ctx) =>
          Effect.gen(function* () {
            const key = `conversation:admission:${Hash.sha256(input.inputID)}`
            const unknown = { status: "uncertain" as const, ref: input.ref, inputID: input.inputID }
            const value = yield* kv.get(key)
            // No first-writer insert here: observing an unknown input must not claim it or send anything.
            if (value === undefined) return unknown
            const stored = yield* Schema.decodeUnknownEffect(Stored)(value).pipe(Effect.orDie)
            const relation = stored.followupOf ? { followupOf: stored.followupOf } : {}
            if (
              stored.inputID !== input.inputID ||
              stored.ref.backendID !== input.ref.backendID ||
              stored.ref.threadID !== input.ref.threadID
            )
              return yield* Effect.fail(ctx.error("conflict", "Input ID belongs to a different request"))
            if (stored.receipt) return { ...unknown, ...relation, status: "accepted" as const, receipt: stored.receipt }
            if (stored.rejection) return { ...stored.rejection, ref: input.ref, inputID: input.inputID, ...relation }
            const backend = get(input.ref.backendID)
            if (!backend) return { ...unknown, ...relation }
            const result = yield* Effect.tryPromise({
              try: () => backend.reconcile(input.ref, input.inputID),
              catch: () => undefined,
            }).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!result || get(input.ref.backendID) !== backend) return { ...unknown, ...relation }
            const receipt = yield* Schema.decodeUnknownEffect(ConversationBackend.Receipt)(result).pipe(Effect.orDie)
            yield* kv.set(key, { ...stored, receipt })
            return { ...unknown, ...relation, status: "accepted" as const, receipt }
          }),
        send: (input, ctx) =>
          Effect.gen(function* () {
            const key = `conversation:admission:${Hash.sha256(input.inputID)}`
            const parent = input.delivery !== "steer" ? input.followupOf : undefined
            const identity = { ref: input.ref, inputID: input.inputID, ...(parent ? { followupOf: parent } : {}) }
            const fingerprint = Hash.sha256(
              JSON.stringify([
                input.ref.backendID,
                input.ref.threadID,
                input.text,
                input.delivery === "steer" ? input.expectedTurnID : null,
                ...(parent ? [[parent.inputID, parent.turnID, parent.nativeID]] : []),
                ...(input.files?.length ? [input.files] : []),
              ]),
            )
            const stored = { ...identity, fingerprint }
            const backend = get(input.ref.backendID)
            if (!backend) return yield* Effect.fail(ctx.error("unavailable", "Conversation backend is unavailable"))
            if (parent && !backend.followup)
              return yield* Effect.fail(ctx.error("unavailable", "Backend linked input is unavailable"))
            // A native SQLite first-writer fact, not a second pending-work queue. No payload is stored.
            const first = yield* kv.insert(key, stored)
            const current = first
              ? stored
              : yield* kv.get(key).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Stored)), Effect.orDie)
            if (
              current.fingerprint !== fingerprint ||
              current.ref.backendID !== input.ref.backendID ||
              current.ref.threadID !== input.ref.threadID
            ) {
              return yield* Effect.fail(ctx.error("conflict", "Input ID belongs to a different request"))
            }
            if ("receipt" in current && current.receipt)
              return { status: "accepted" as const, ...identity, receipt: current.receipt }
            if ("rejection" in current && current.rejection) return { ...current.rejection, ...identity }
            // An interrupted or concurrent request is never sent again. Only native state can confirm delivery.
            const result = yield* Effect.tryPromise({
              try: () =>
                first
                  ? input.files?.length && !backend.descriptor.images
                    ? Promise.resolve({ status: "rejected" as const, reason: "not-accepted" as const })
                    : parent
                      ? backend.followup!({ ...input, delivery: "queue", followupOf: parent })
                      : backend.enqueue(input)
                  : backend.reconcile(input.ref, input.inputID),
              catch: () => undefined,
            }).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!result) return { status: "uncertain" as const, ...identity }
            if ("status" in result && result.status === "rejected") {
              const rejection = yield* Schema.decodeUnknownEffect(ConversationBackend.Rejection)(result).pipe(
                Effect.orDie,
              )
              yield* kv.set(key, { ...stored, rejection })
              return { ...rejection, ...identity }
            }
            const receipt = yield* Schema.decodeUnknownEffect(ConversationBackend.Receipt)(result).pipe(Effect.orDie)
            yield* kv.set(key, { ...stored, receipt })
            return { status: "accepted" as const, ...identity, receipt }
          }),
      })
      const runtime = yield* Effect.context<Scope.Scope>()
      const run = Effect.runPromiseWith(runtime)
      const listener = (backendID: string, notification: Schema.Json) => {
        void run(registration.events.emit("notification", { backendID, notification })).catch(() => undefined)
      }
      listeners.add(listener)
      const onContent = (event: ConversationBackend.Content) => {
        void run(registration.events.emit("content", event)).catch(() => undefined)
      }
      content.add(onContent)
      const onChanged = () => {
        void run(registration.events.emit("changed", {})).catch(() => undefined)
      }
      const onAuthentication = (backendID: string, event: ConversationBackend.AuthenticationEvent) => {
        void run(registration.events.emit("authentication", { backendID, event })).catch(() => undefined)
      }
      changed.add(onChanged)
      authentication.add(onAuthentication)
      const onActivity = (event: ConversationBackend.Activity) => {
        void run(registration.events.emit("activity", event)).catch(() => undefined)
      }
      activity.add(onActivity)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          listeners.delete(listener)
          changed.delete(onChanged)
          authentication.delete(onAuthentication)
          activity.delete(onActivity)
          content.delete(onContent)
        }),
      )
    })
    return Service.of({ register, bind })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [KV.node] })
