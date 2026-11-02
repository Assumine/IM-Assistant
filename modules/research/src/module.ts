import type { ApplicationModule } from "../../../opencode/packages/plugin/src/promise/application"
import { createDispatcher } from "./dispatcher"
import type { Request, ResearchPath, Scoring } from "./types"

/** Optional application capability. Native Session/Inbox remain the owners of AI tasks. */
export function createResearchModule(options: { paths: readonly ResearchPath[]; scoring?: Partial<Scoring> }) {
  const ready = Promise.withResolvers<void>()
  let active: ReturnType<typeof createDispatcher> | undefined
  let opened = false
  const module: ApplicationModule & {
    ready: Promise<void>
    run: ReturnType<typeof createDispatcher>["run"]
    history: ReturnType<typeof createDispatcher>["history"]
  } = {
    id: "research", title: "Research scripts", ready: ready.promise,
    run: (request: Request) => active ? active.run(request) : Promise.reject(new Error("Research module is not active")),
    history: () => active ? active.history() : Promise.reject(new Error("Research module is not active")),
    open(context) {
      if (opened) throw new Error("Research module resource already opened")
      opened = true
      active = createDispatcher({ ...options, storage: context.storage })
      context.capability.report({ phase: "ready" })
      ready.resolve()
      return {
        async close() {
          const dispatcher = active
          active = undefined
          await dispatcher?.close()
        },
      }
    },
  }
  return module
}
