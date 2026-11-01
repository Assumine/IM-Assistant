export * as ApplicationModules from "./application-modules"

import { OpenCode } from "@opencode/client"
import { KV } from "@opencode/core/kv"
import { storage } from "@opencode/core/plugin/host"
import type { ApplicationModule } from "@opencode/plugin/promise/application"
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import { Effect } from "effect"

/** Trusted composition only. Neither requests nor serialized module settings can contribute executable code. */
export const install = Effect.fn("ApplicationModules.install")(function* (
  modules: readonly ApplicationModule[],
  handler: (request: Request) => Promise<Response>,
  options: { readonly password?: string; readonly directory?: string } = {},
) {
  const kv = yield* KV.Service
  const context = yield* Effect.context<never>()
  const run = Effect.runPromiseWith(context)
  const seen = new Set<string>()
  for (const module of modules) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(module.id) || seen.has(module.id)) {
      yield* Effect.logWarning("Application module identity is invalid or duplicated")
      continue
    }
    seen.add(module.id)
    yield* Effect.gen(function* () {
      let closed = false
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
      yield* Effect.acquireRelease(
        Effect.sync(() => module.open({ client, storage: owned })),
        (resource) =>
          Effect.tryPromise(() => resource.close()).pipe(
            Effect.catchCause(() => Effect.logWarning("Application module cleanup failed", { module: module.id })),
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
    }).pipe(
      Effect.catchCause(() => Effect.logWarning("Optional application module is unavailable", { module: module.id })),
    )
  }
})
