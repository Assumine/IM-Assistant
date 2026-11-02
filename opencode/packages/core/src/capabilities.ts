export * as Capabilities from "./capabilities.js"

import { Clock, Context, Effect, Layer, Schema, Scope } from "effect"
import { Capability } from "@opencode/schema/capability"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { CapabilityNotifications } from "./capability-notifications.js"
import type { Rpc } from "./rpc.js"
import type { Tool } from "@opencode/schema/tool"
import { definition, effectiveName } from "./tool/runtime.js"

export interface Registration {
  readonly report: (value: Capability.Health) => void
  readonly state: (value: Capability.Info["state"]) => void
  readonly inspect: (read?: (signal: AbortSignal) => Promise<readonly Capability.Metric[]>) => void
  readonly expose: (tools: readonly Tool.Info[]) => void
  readonly present: (
    read?: (input: { readonly locale?: string; readonly signal: AbortSignal }) => Promise<Capability.View>,
  ) => void
  readonly invalidate: () => void
  readonly act: (
    invoke?: (input: Capability.Invocation & { readonly signal: AbortSignal }) => Promise<Capability.ActionResult>,
  ) => void
  readonly notify: (value: Capability.NoticeInput) => Effect.Effect<void, Error>
  readonly resolve: (id: string) => Effect.Effect<void, Error>
}
export interface Interface {
  /** Only tools installed by the trusted application composition, never Location/project transforms. */
  readonly tools: () => readonly Tool.Info[]
  readonly register: (input: {
    readonly id: string
    readonly title?: string
    readonly stop: () => Promise<void>
    readonly settings?: {
      readonly read: (signal: AbortSignal) => Promise<Capability.Settings>
      readonly write: (
        input: { readonly revision: string; readonly text: string },
        signal: AbortSignal,
      ) => Promise<Capability.Settings | undefined>
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
  tools: readonly Tool.Info[]
  metrics?: (signal: AbortSignal) => Promise<readonly Capability.Metric[]>
  sample?: { readonly at: number; readonly value: Promise<Capability.Metrics>; pending: boolean }
  view?: (input: { readonly locale?: string; readonly signal: AbortSignal }) => Promise<Capability.View>
  invoke?: (input: Capability.Invocation & { readonly signal: AbortSignal }) => Promise<Capability.ActionResult>
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const notices = yield* CapabilityNotifications.Service
    const entries = new Map<string, Entry>()
    const listeners = new Set<() => void>()
    const viewListeners = new Set<(id: string) => void>()
    const viewChanged = (id: string) => {
      for (const listener of viewListeners) listener(id)
    }
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
      tools: () => Array.from(entries.values()).flatMap((entry) => (entry.info.state === "active" ? entry.tools : [])),
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
        const entry: Entry = {
          info,
          stop: input.stop,
          controller: new AbortController(),
          settings: input.settings,
          tools: [],
        }
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
              entry.tools = []
              entry.view = undefined
              entry.invoke = undefined
              if (entry.info.view) {
                entry.info = { ...entry.info, view: false }
                viewChanged(id)
              }
            }
            changed()
          },
          inspect(read?: (signal: AbortSignal) => Promise<readonly Capability.Metric[]>) {
            if (!live(entry)) throw new Error("Capability is closed")
            entry.metrics = read
            entry.info = { ...entry.info, metrics: !!read }
            changed()
          },
          expose(tools: readonly Tool.Info[]) {
            if (!live(entry)) throw new Error("Capability is closed")
            const names = tools.map(effectiveName)
            if (
              new Set(names).size !== names.length ||
              names.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) ||
              Array.from(entries.values()).some(
                (other) => other !== entry && other.tools.some((tool) => names.includes(effectiveName(tool))),
              )
            )
              throw new Error("Invalid or duplicate application tool")
            for (const tool of tools) definition(tool)
            entry.tools = [...tools]
          },
          present(read) {
            if (!live(entry)) throw new Error("Capability is closed")
            entry.view = read
            if (read || entry.info.view) entry.info = { ...entry.info, view: !!read }
            changed()
          },
          invalidate() {
            if (live(entry) && entry.view) viewChanged(id)
          },
          act(invoke) {
            if (!live(entry)) throw new Error("Capability is closed")
            entry.invoke = invoke
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
          view: (input) =>
            Effect.gen(function* () {
              const entry = entries.get(input.id)
              if (!entry || entry.info.state !== "active") return { id: input.id, status: "unavailable" as const }
              const read = entry.view
              if (!read) return { id: input.id, status: "unsupported" as const }
              return yield* Effect.tryPromise({
                try: async (signal): Promise<Capability.ViewResult> => {
                  const document = await read({
                    ...(input.locale ? { locale: input.locale } : {}),
                    signal: AbortSignal.any([signal, entry.controller.signal]),
                  })
                  if (!live(entry)) return { id: input.id, status: "unavailable" }
                  return {
                    id: input.id,
                    status: "ready",
                    document: Schema.decodeUnknownSync(Capability.View)(document),
                  }
                },
                catch: () => new Error("Module view unavailable"),
              }).pipe(Effect.catchCause(() => Effect.succeed({ id: input.id, status: "failed" as const })))
            }),
          invoke: (input, ctx) =>
            Effect.gen(function* () {
              const entry = entries.get(input.id)
              const invoke = entry?.info.state === "active" ? entry.invoke : undefined
              if (!entry || !invoke)
                return yield* Effect.fail(ctx.error("unavailable", "Module controls are unavailable"))
              return yield* Effect.tryPromise({
                try: async (signal) => {
                  const combined = AbortSignal.any([signal, entry.controller.signal])
                  const result = await invoke({ ...input, signal: combined })
                  if (combined.aborted || !live(entry)) throw new Error("Module was stopped")
                  return Schema.decodeUnknownSync(Capability.ActionResult)(result)
                },
                catch: () => ctx.error("failed", "Operation was not confirmed; inspect the module before retrying"),
              })
            }),
          settings: (input, ctx) =>
            Effect.gen(function* () {
              const settings = entries.get(input.id)?.settings
              if (!settings) return yield* Effect.fail(ctx.error("unavailable", "Module settings are unavailable"))
              return yield* Effect.tryPromise({
                try: async (signal) => Schema.decodeUnknownSync(Capability.Settings)(await settings.read(signal)),
                catch: () => ctx.error("failed", "Module settings could not be read safely"),
              })
            }),
          configure: (input, ctx) =>
            Effect.gen(function* () {
              const settings = entries.get(input.id)?.settings
              if (!settings) return yield* Effect.fail(ctx.error("unavailable", "Module settings are unavailable"))
              const result = yield* Effect.tryPromise({
                try: async (signal) => {
                  const value = await settings.write({ revision: input.revision, text: input.text }, signal)
                  return value === undefined ? undefined : Schema.decodeUnknownSync(Capability.Settings)(value)
                },
                catch: () =>
                  ctx.error(
                    "failed",
                    "Settings were not confirmed. Check the configuration and explicit context-reset requirements",
                  ),
              })
              if (!result)
                return yield* Effect.fail(ctx.error("conflict", "Settings changed. Reload before saving again"))
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
        const viewListener = (id: string) => {
          Effect.runForkWith(context)(
            registration.events.emit("viewChanged", { id }).pipe(Effect.catchCause(() => Effect.void)),
          )
        }
        yield* Effect.acquireRelease(
          Effect.sync(() => listeners.add(listener)),
          () => Effect.sync(() => listeners.delete(listener)),
        )
        yield* Effect.acquireRelease(
          Effect.sync(() => viewListeners.add(viewListener)),
          () => Effect.sync(() => viewListeners.delete(viewListener)),
        )
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [CapabilityNotifications.node] })
