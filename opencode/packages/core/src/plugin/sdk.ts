export * as SdkPlugins from "./sdk.js"

import type { Plugin } from "@opencode/plugin/effect/plugin"
import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Bus } from "../bus.js"
import type { Generation } from "../plugin.js"

export const Updated = Bus.ephemeral({ type: "sdk.plugin.updated", schema: {} })

/**
 * Holds the plugins an embedder (the `@opencode/sdk` host) contributes,
 * so the application loader can add them on every Location boot through its
 * ordinary generation path. Registration publishes an unlocated update so every booted Location
 * reloads its plugin generation from the shared store.
 *
 * Each host-global layer owns one private store. Location graphs reuse that
 * layer through Effect's memoization, so separate hosts remain isolated while
 * every Location in one host sees the same registrations.
 */
export interface Interface {
  readonly register: (plugin: Plugin) => Effect.Effect<void>
  /** Trusted, compiled host composition only; never exposed through config, HTTP or a plugin context. */
  readonly registerTrusted: (plugin: Plugin) => Effect.Effect<void>
  readonly all: (options?: { readonly trustedOnly?: boolean }) => readonly Generation[]
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SdkPlugins") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const plugins = new Map<string, { generation: Generation; trusted: boolean }>()
    let revision = 0
    const register = (plugin: Plugin, trusted: boolean) =>
      Effect.sync(() => {
        plugins.set(plugin.id, {
          generation: { ...plugin, revision: String(++revision), source: { type: "sdk" } },
          trusted,
        })
      }).pipe(Effect.andThen(bus.publish(Updated, {}, { global: true })), Effect.asVoid)
    return Service.of({
      register: (plugin) => register(plugin, false),
      registerTrusted: (plugin) => register(plugin, true),
      all: (options) =>
        [...plugins.values()]
          .filter((entry) => !options?.trustedOnly || entry.trusted)
          .map((entry) => entry.generation),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Bus.node] })
