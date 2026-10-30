import { Effect } from "effect"
import { define } from "@opencode/plugin/effect/plugin"
import { Npm } from "@opencode/util/npm"
import { loadSDKFactory } from "./sdk-factory.js"
import { RuntimePolicy } from "../../runtime-policy.js"

export const DynamicProviderPlugin = define({
  id: "opencode.provider.dynamic",
  effect: Effect.fn(function* (ctx) {
    const npm = yield* Npm.Service
    const policy = yield* RuntimePolicy.Service
    yield* ctx.aisdk.hook(
      "sdk",
      Effect.fn(function* (evt) {
        if (evt.sdk) return
        if (policy.managed && !/^@opencode\/ai\/providers\/[a-z0-9-]+(?:\/[a-z0-9-]+)?$/.test(evt.package))
          return yield* Effect.die(new Error("External provider packages are disabled by runtime policy"))

        evt.sdk = ((yield* loadSDKFactory(npm, evt.package)) as (options: any) => any)(evt.options)
      }),
    )
  }),
})
