import { Config } from "@opencode/core/config"
import { ShellSelect } from "@opencode/core/shell/select"
import { Provider } from "@opencode/core/provider"
import { Plugin } from "@opencode/core/plugin"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"
import { ConflictError, InvalidRequestError } from "@opencode/protocol/errors"

export const ConfigHandler = HttpApiBuilder.group(Api, "server.config", (handlers) =>
  handlers
    .handle(
      "config.provider.create",
      Effect.fn(function* (ctx) {
        const config = yield* Config.Service
        if (!config.addProvider)
          return yield* new InvalidRequestError({ message: "API connection configuration is unavailable" })
        yield* Plugin.awaitActivation
        const providers = yield* Provider.Service
        if (yield* providers.get(Provider.ID.make(ctx.payload.id)))
          return yield* new ConflictError({ resource: ctx.payload.id, message: "Connection ID already exists" })
        yield* config.addProvider(ctx.payload).pipe(
          Effect.catch((error): Effect.Effect<never, ConflictError | InvalidRequestError> => {
            if (error._tag !== "Config.ProviderConnectionError") return Effect.die(error)
            if (error.reason === "exists")
              return Effect.fail(
                new ConflictError({
                  resource: error.id,
                  message: "Connection ID already exists; use a new ID to preserve existing sessions",
                }),
              )
            return Effect.fail(
              new InvalidRequestError({ message: "Invalid API address, model limits or configuration document" }),
            )
          }),
        )
      }),
    )
    .handle("config.get", () => Config.Service.use((config) => config.entries()))
    .handle(
      "config.update",
      Effect.fn(function* (ctx) {
        const config = yield* Config.Service
        if (!config.update) return yield* Effect.die(new Error("Config updates are unavailable"))
        return yield* config.update(ctx.payload).pipe(Effect.orDie)
      }),
    )
    .handle(
      "config.shells",
      Effect.fn(function* () {
        const shell = yield* ShellSelect.Service
        if (!shell.list) return yield* Effect.die(new Error("Shell discovery is unavailable"))
        return yield* shell.list()
      }),
    ),
)
