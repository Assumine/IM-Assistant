export * as ApplicationModules from "./application-modules"

import { OpenCode } from "@opencode/client"
import { KV } from "@opencode/core/kv"
import { Capabilities } from "@opencode/core/capabilities"
import { storage } from "@opencode/core/plugin/host"
import type { ApplicationModuleEntry } from "@opencode/plugin/promise/application"
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import { Cause, Effect, Exit, Scope } from "effect"

/** Trusted composition only. Neither requests nor serialized module settings can contribute executable code. */
export const install = Effect.fn("ApplicationModules.install")(function* (
  modules: readonly ApplicationModuleEntry[],
  handler: (request: Request) => Promise<Response>,
  options: { readonly password?: string; readonly directory?: string } = {},
) {
  const kv = yield* KV.Service
  const capabilities = yield* Capabilities.Service
  const parent = yield* Scope.Scope
  const context = yield* Effect.context<never>()
  const run = Effect.runPromiseWith(context)
  const seen = new Set<string>()
  for (const module of modules) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(module.id) || seen.has(module.id)) {
      yield* Effect.logWarning("Application module identity is invalid or duplicated")
      continue
    }
    seen.add(module.id)
    const owner = yield* Scope.fork(parent)
    const capability = yield* capabilities
      .register({
        id: module.id,
        title: module.title,
        stop: () => run(Scope.close(owner, Exit.void)),
        settings: module.settings,
      })
      .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
    if (!capability) {
      yield* Effect.logWarning("Application module metadata is unavailable", { module: module.id })
      continue
    }
    let closed = false
    let outcome: "stopped" | "failed" | "disabled" = "stopped"
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closed = true
        capability.state(outcome)
      }),
    ).pipe(Effect.provideService(Scope.Scope, owner))
    const open = Effect.gen(function* () {
      const loaded = "load" in module ? yield* Effect.tryPromise((signal) => module.load(signal)) : module
      if (!loaded) {
        closed = true
        outcome = "disabled"
        capability.state("disabled")
        return
      }
      if (closed) return
      if (loaded.id !== module.id) return yield* Effect.die(new Error("Application module changed its identity"))
      const fetch = Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          if (closed) throw new Error("Application module is closed")
          const request = new Request(input, init)
          if (options.password)
            request.headers.set(
              "authorization",
              "Basic " + Buffer.from("opencode:" + options.password).toString("base64"),
            )
          if (options.directory) request.headers.set("x-opencode-directory", encodeURIComponent(options.directory))
          return handler(request)
        },
        { preconnect: () => undefined },
      ) satisfies typeof globalThis.fetch
      const client = OpenCode.make({ baseUrl: "http://opencode.module", fetch })
      const original = storage(kv, module.id)
      const owned: StorageDomain = {
        get: (key) => (closed ? Promise.reject(new Error("Application module is closed")) : run(original.get(key))),
        set: (key, value) =>
          closed ? Promise.reject(new Error("Application module is closed")) : run(original.set(key, value)),
        insert: (key, value) =>
          closed ? Promise.reject(new Error("Application module is closed")) : run(original.insert(key, value)),
        remove: (key) =>
          closed ? Promise.reject(new Error("Application module is closed")) : run(original.remove(key)),
        scan: (options) =>
          closed ? Promise.reject(new Error("Application module is closed")) : run(original.scan(options)),
      }
      const resource = yield* Effect.acquireRelease(
        Effect.sync(() =>
          loaded.open({
            client,
            storage: owned,
            capability: {
              report: (value) => {
                if (closed) throw new Error("Application module is closed")
                capability.report(value)
              },
              notify: (value) =>
                closed ? Promise.reject(new Error("Application module is closed")) : run(capability.notify(value)),
              resolve: (id) =>
                closed ? Promise.reject(new Error("Application module is closed")) : run(capability.resolve(id)),
            },
          }),
        ),
        (resource) =>
          Effect.tryPromise(() => resource.close()).pipe(
            Effect.catchCause(() => {
              outcome = "failed"
              return Effect.logWarning("Application module cleanup failed", { module: module.id })
            }),
            Effect.ensuring(
              Effect.sync(() => {
                closed = true
              }),
            ),
          ),
      ).pipe(
        Effect.onExit((exit) =>
          exit._tag === "Failure"
            ? Effect.sync(() => {
                closed = true
              })
            : Effect.void,
        ),
      )
      capability.inspect(resource.metrics)
      capability.state("active")
    }).pipe(
      Effect.provideService(Scope.Scope, owner),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.void
        closed = true
        outcome = "failed"
        capability.state("failed")
        return Effect.logWarning("Optional application module is unavailable", { module: module.id })
      }),
    )
    if ("load" in module) yield* Effect.forkIn(open, owner)
    else yield* open
  }
})
