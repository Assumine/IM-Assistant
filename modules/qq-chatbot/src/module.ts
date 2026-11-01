import type { ApplicationModule } from "../../../opencode/packages/plugin/src/promise/application"
import { configuration } from "./configuration"
import { createChatSessions } from "./sessions"
import type { Account, ChatInput, Configuration, Receipt } from "./types"

/** Compiled module plus its ingress port. Opening/closing it never opens or stops a task-portal resource. */
export function createChatbotModule(options: Configuration) {
  const config = configuration(options), ready = Promise.withResolvers<"ready" | "degraded" | "unavailable" | "closed">()
  const unavailable = new Set<string>()
  let active: ReturnType<typeof createChatSessions> | undefined, opened = false, stopped = false
  const module: ApplicationModule & { ready: Promise<"ready" | "degraded" | "unavailable" | "closed">; receive: (input: ChatInput) => Promise<Receipt> } = {
    id: "qq-chatbot", title: "QQ chat companion", ready: ready.promise,
    receive: (input) => active && !unavailable.has(input?.scope?.botID) ? active.receive(input) : Promise.resolve({ status: "unavailable" }),
    open(context) {
      if (opened) throw new Error("QQ chatbot resource already opened")
      opened = true
      const abort = new AbortController()
      context.capability.report({ phase: "starting" })
      const startup = (async () => {
        try {
          const models = await context.client.model.list({ location: config.location }, { signal: abort.signal })
          const accounts: Account[] = []
          for (const account of config.accounts) {
            if (!models.data.some((model) => model.enabled && model.providerID === account.model.providerID &&
              model.id === account.model.id && model.capabilities.input.includes("text") && model.capabilities.output.includes("text") &&
              (account.model.variant === "default" || model.variants.some((variant) => variant.id === account.model.variant)))) {
              unavailable.add(account.botID)
              continue
            }
            try {
              const agent = await context.client.agent.get({ location: config.location, agentID: account.agentID! }, { signal: abort.signal })
              if (agent.data.mode === "subagent") { unavailable.add(account.botID); continue }
              accounts.push(account)
            } catch { unavailable.add(account.botID) }
          }
          if (stopped) return
          if (accounts.length) active = createChatSessions({ config: { ...config, accounts }, context })
          const phase = accounts.length === config.accounts.length ? "ready" : accounts.length ? "degraded" : "unavailable"
          context.capability.report({ phase })
          ready.resolve(phase)
        } catch {
          if (stopped) return
          context.capability.report({ phase: "unavailable" })
          ready.resolve("unavailable")
        }
      })()
      return {
        async close() {
          stopped = true
          const resource = active
          active = undefined
          ready.resolve("closed")
          abort.abort()
          await Promise.allSettled([startup, resource?.close()])
        },
      }
    },
  }
  return module
}
