import { ConversationBackend } from "@opencode/core/conversation-backend"
import type { Module } from "@opencode/plugin/effect/conversation"
import { Effect } from "effect"

/** Optional trusted modules start independently; their acquisition and registration live in the application scope. */
export const install = Effect.fn("BackendModules.install")(function* (modules: readonly Module[]) {
  const domain = yield* ConversationBackend.Service
  for (const module of modules) {
    const run = Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* Effect.acquireRelease(
          Effect.tryPromise(() => module.open()),
          (connection) =>
            Effect.tryPromise(() => connection.close()).pipe(
              Effect.catch(() =>
                Effect.logWarning("Conversation backend module cleanup failed", { module: module.id }),
              ),
            ),
        )
        if (connection.backend.descriptor.id !== module.id)
          return yield* Effect.fail(new Error("Backend module identity mismatch"))
        yield* domain.register(connection.backend)
        yield* Effect.never
      }),
    ).pipe(Effect.catchCause(() => Effect.logWarning("Conversation backend module unavailable", { module: module.id })))
    yield* Effect.forkScoped(run)
  }
})
export * as BackendModules from "./backend-modules"
