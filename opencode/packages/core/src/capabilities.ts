export * as Capabilities from "./capabilities.js"

import { Clock, Context, Effect, Layer, Schema, Scope } from "effect"
import { Capability } from "@opencode/schema/capability"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { CapabilityNotifications } from "./capability-notifications.js"
import type { Rpc } from "./rpc.js"

export interface Registration {
  readonly report: (value: Capability.Health) => void
  readonly state: (value: Capability.Info["state"]) => void
  readonly inspect: (read?: (signal: AbortSignal) => Promise<readonly Capability.Metric[]>) => void
  readonly notify: (value: Capability.NoticeInput) => Effect.Effect<void, Error>
  readonly resolve: (id: string) => Effect.Effect<void, Error>
}
export interface Interface {
  readonly register: (input: {
    readonly id: string
    readonly title?: string
    readonly stop: () => Promise<void>
    readonly settings?: {
      readonly read: (signal: AbortSignal) => Promise<Capability.Settings>
      readonly write: (input: { readonly revision: string; readonly text: string }, signal: AbortSignal) => Promise<Capability.Settings | undefined>
    }
  }) => Effect.Effect<Registration, Error>
  readonly bind: (rpc: Rpc.Interface) => Effect.Effect<void, unknown, Scope.Scope>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/Capabilities") {}

interface Entry {
  info: Capability.Info
  readonly stop: () => Promise<void>
  readonly controller: AbortController
  readonly settings?: Parameters<Interface["register"]>[0]["settings"]
  metrics?: (signal: AbortSignal) => Promise<readonly Capability.Metric[]>
  sample?: { readonly at: number; readonly value: Promise<Capability.Metrics>; pending: boolean }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const notices = yield* CapabilityNotifications.Service
    const entries = new Map<string, Entry>()
    const listeners = new Set<() => void>()
    const changed = () => {
      for (const listener of listeners) listener()
    }
    const live = (entry: Entry) => entry.info.state === "active" || entry.info.state === "loading"
    const snapshot = (entry: Entry): Capability.Info => ({ ...entry.info })
    const metrics = Effect.fn("Capabilities.metrics")(function* (id: string) {
      const entry = entries.get(id)
      if (!entry || entry.info.state !== "active") return { id, status: "unavailable" as const, items: [] }
      const measure = entry.metrics
      if (!measure) return { id, status: "unsupported" as const, items: [] }
      const now = yield* Clock.currentTimeMillis
      return yield* Effect.tryPromise({
        try: (signal) => {
          if (entry.sample && (entry.sample.pending || (now >= entry.sample.at && now - entry.sample.at < 1000)))
            return entry.sample.value
          const combined = AbortSignal.any([signal, entry.controller.signal])
          const value: Promise<Capability.Metrics> = Promise.resolve()
            .then(() => {
              if (combined.aborted) throw new Error("Capability is closed")
              return measure(combined)
            })
            .then((items): Capability.Metrics => {
              if (combined.aborted || !live(entry)) return { id, status: "unavailable", items: [] }
              const data = Schema.decodeUnknownSync(Schema.Array(Capability.Metric).check(Schema.isMaxLength(64)))(
                items,
              )
              if (new Set(data.map((item) => item.id)).size !== data.length)
                throw new Error("Duplicate metric identity")
              return { id, status: "ready", collectedAt: now, items: data }
            })
            .catch((): Capability.Metrics => ({ id, status: "failed", items: [] }))
          const sample = { at: now, value, pending: true }
          entry.sample = sample
          void value.then(() => {
            sample.pending = false
          })
          return value
        },
        catch: () => new Error("Capability metrics are unavailable"),
      }).pipe(Effect.orDie)
    })
    return Service.of({
      register: Effect.fn("Capabilities.register")(function* (input: Parameters<Interface["register"]>[0]) {
        const id = yield* Schema.decodeUnknownEffect(Capability.ID)(input.id).pipe(Effect.orDie)
        if (entries.has(id)) return yield* Effect.fail(new Error("Capability is already registered"))
        const info = yield* Schema.decodeUnknownEffect(Capability.Info)({
          id,
          title: input.title ?? id,
          state: "loading",
          metrics: false,
          ...(input.settings ? { settings: true } : {}),
        }).pipe(Effect.orDie)
        const entry: Entry = { info, stop: input.stop, controller: new AbortController(), settings: input.settings }
        entries.set(id, entry)
        changed()
        return {
          report(value: Capability.Health) {
            if (!live(entry)) throw new Error("Capability is closed")
            entry.info = { ...entry.info, health: Schema.decodeUnknownSync(Capability.Health)(value) }
            changed()
          },
          state(state: Capability.Info["state"]) {
            entry.info = { ...entry.info, state }
            if (!live(entry)) {
              entry.controller.abort()
              entry.metrics = undefined
              entry.sample = undefined
              entry.info = { ...entry.info, metrics: false, health: undefined }
            }
            changed()
          },
          inspect(read?: (signal: AbortSignal) => Promise<readonly Capability.Metric[]>) {
            if (!live(entry)) throw new Error("Capability is closed")
            entry.metrics = read
            entry.info = { ...entry.info, metrics: !!read }
            changed()
          },
          notify: (value: Capability.NoticeInput) =>
            Effect.suspend(() =>
              live(entry)
                ? notices.publish(id, value).pipe(
                    Effect.tap((created) =>
                      Effect.sync(() => {
                        if (created) changed()
                      }),
                    ),
                    Effect.asVoid,
                  )
                : Effect.fail(new Error("Capability is closed")),
            ),
          resolve: (noticeID: string) =>
            Effect.suspend(() =>
              live(entry)
                ? notices.resolve({ moduleID: id, id: noticeID }).pipe(
                    Effect.tap((resolved) =>
                      Effect.sync(() => {
                        if (resolved) changed()
                      }),
                    ),
                    Effect.asVoid,
                  )
                : Effect.fail(new Error("Capability is closed")),
            ),
        }
      }),
      bind: Effect.fn("Capabilities.bind")(function* (rpc: Rpc.Interface) {
        const context = yield* Effect.context<never>()
        const registration = yield* rpc.register(Capability.Api, {
          list: () => Effect.sync(() => Array.from(entries.values(), snapshot)),
          stop: (input, ctx) =>
            Effect.gen(function* () {
              const entry = entries.get(input.id)
              if (!entry) return yield* Effect.fail(ctx.error("unavailable", "Capability is unavailable"))
              yield* Effect.tryPromise({
                try: entry.stop,
                catch: () => ctx.error("failed", "Capability could not be stopped"),
              })
              return snapshot(entry)
            }),
          metrics: (input) => metrics(input.id),
          settings: (input, ctx) => Effect.gen(function* () {
            const settings = entries.get(input.id)?.settings
            if (!settings) return yield* Effect.fail(ctx.error("unavailable", "Module settings are unavailable"))
            return yield* Effect.tryPromise({
              try: async (signal) => Schema.decodeUnknownSync(Capability.Settings)(await settings.read(signal)),
              catch: () => ctx.error("failed", "Module settings could not be read safely"),
            })
          }),
          configure: (input, ctx) => Effect.gen(function* () {
            const settings = entries.get(input.id)?.settings
            if (!settings) return yield* Effect.fail(ctx.error("unavailable", "Module settings are unavailable"))
            const result = yield* Effect.tryPromise({
              try: async (signal) => {
                const value = await settings.write({ revision: input.revision, text: input.text }, signal)
                return value === undefined ? undefined : Schema.decodeUnknownSync(Capability.Settings)(value)
              },
              catch: () => ctx.error("failed", "Settings were not confirmed. Check the configuration and explicit context-reset requirements"),
            })
            if (!result) return yield* Effect.fail(ctx.error("conflict", "Settings changed. Reload before saving again"))
            changed()
            return result
          }),
          notifications: (input, ctx) =>
            notices
              .list(input)
              .pipe(Effect.catchCause(() => Effect.fail(ctx.error("failed", "Notifications are unavailable")))),
          markRead: (input, ctx) =>
            notices.read(input).pipe(
              Effect.tap((value) =>
                Effect.sync(() => {
                  if (value.changed) changed()
                }),
              ),
              Effect.map((value) => value.notice),
              Effect.catchCause(() => Effect.fail(ctx.error("failed", "Notification could not be marked read"))),
            ),
        })
        const listener = () => {
          Effect.runForkWith(context)(
            registration.events.emit("changed", {}).pipe(Effect.catchCause(() => Effect.void)),
          )
        }
        yield* Effect.acquireRelease(
          Effect.sync(() => listeners.add(listener)),
          () => Effect.sync(() => listeners.delete(listener)),
        )
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [CapabilityNotifications.node] })
