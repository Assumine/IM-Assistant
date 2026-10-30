export * as RuntimePolicy from "./runtime-policy.js"

import { Context, Effect, Layer, Schema } from "effect"
import path from "node:path"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Global } from "@opencode/util/global"

// A trusted host preset, never model configuration or a session permission override.
export const Options = Schema.Struct({ managedDirectory: Schema.optional(Schema.String) })
export type Options = typeof Options.Type

export class Service extends Context.Service<Service, {
  readonly managed: boolean
  readonly allowsDirectory: (directory: string) => boolean
}>()("@opencode/RuntimePolicy") {}

export function configured(options: Options = {}) {
  return makeGlobalNode({
    service: Service,
    layer: Layer.effect(Service, Effect.map(Global.Service, global => {
      const key = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value)
      const allowed = new Set([options.managedDirectory, global.config].filter((value): value is string => !!value).map(key))
      return Service.of({
        managed: options.managedDirectory !== undefined,
        allowsDirectory: directory => options.managedDirectory === undefined || allowed.has(key(directory)),
      })
    })),
    deps: [Global.node],
  })
}

export const node = configured()
