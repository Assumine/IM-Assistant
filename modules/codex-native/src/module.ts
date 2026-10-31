import type { Module } from "../../../opencode/packages/plugin/src/effect/conversation"
import { CodexSessionAdapter } from "./session-adapter"
import { nativeBackend } from "./backend"
import type { Launch } from "./transport"

/** Trusted host composition only. Creation/login/send remain explicit actions after native registration. */
export function nativeModule(options: Launch): Module {
  return {
    id: "codex-native",
    async open() {
      const adapter = await CodexSessionAdapter.open(options)
      try {
        return { backend: nativeBackend(adapter), close: () => adapter.close() }
      } catch (error) {
        await adapter.close()
        throw error
      }
    },
  }
}
