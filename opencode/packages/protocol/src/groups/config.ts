import { Config } from "@opencode/schema/config"
import { ConfigShell } from "@opencode/schema/config/shell"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"
import { LocationQuery, locationQueryOpenApi } from "./location.js"
import { ConflictError, InvalidRequestError } from "../errors.js"

export const ConfigGroup = HttpApiGroup.make("server.config")
  .add(
    HttpApiEndpoint.post("config.provider.create", "/api/experimental/config/provider", {
      payload: Config.ProviderConnection,
      success: HttpApiSchema.NoContent,
      error: [ConflictError, InvalidRequestError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.config.provider.create",
        summary: "Add an OpenAI-compatible API connection",
        description:
          "Experimental: may change without compatibility guarantees. Create a new connection without secrets or changing existing provider IDs and session selections.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("config.get", "/api/config", {
      query: LocationQuery,
      success: Schema.Array(Config.Entry),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "config.get",
          summary: "Get configuration",
          description:
            "Return configuration documents and discovery sources for the requested location, from lowest to highest priority.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("config.shells", "/api/config/shell", {
      success: Schema.Array(ConfigShell.Option),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "config.shells",
        summary: "List available shells",
        description: "Return shells available to terminal and agent execution.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.patch("config.update", "/api/experimental/config", {
      payload: Config.Patch,
      success: HttpApiSchema.NoContent,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.config.update",
        summary: "Update global configuration",
        description: "Patch supported fields in the highest-precedence global configuration document.",
      }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "config", description: "Location-scoped configuration routes." }))
