import type { ApplicationModule } from "../../../opencode/packages/plugin/src/promise/application"
import type { Info } from "../../../opencode/packages/plugin/src/promise/tool"
import { createOwner } from "./owner"
import { researchService } from "./service"
import { createResearchMcp } from "./mcp"
import type { Identity, Primitive } from "./contracts"
import { json } from "./contracts"
import { ConversationBackend } from "../../../opencode/packages/schema/src/conversation-backend"
import type { Data, ResearchPath, Scoring } from "./types"

/** Optional application capability. Native Session/Inbox remain the owners of AI tasks. */
export function createResearchModule(options: { paths?: readonly ResearchPath[]; primitives?: readonly Primitive[]; scoring?: Partial<Scoring> }) {
  const ready = Promise.withResolvers<void>()
  let active: ReturnType<typeof createOwner> | undefined
  let service: ReturnType<typeof researchService> | undefined
  const tools: Info[] = []
  let opened = false
  const module: ApplicationModule & {
    ready: Promise<void>
    run: ReturnType<typeof createOwner>["run"]
    history: ReturnType<typeof createOwner>["history"]
    call: (actor: Identity, name: string, input: unknown, signal?: AbortSignal) => Promise<Data>
    mcp: (authenticate: (token: string) => Promise<Identity | undefined>) => (request: Request) => Promise<Response>
  } = {
    id: "research", title: "Research scripts", ready: ready.promise,
    run: (request) => active ? active.run(request) : Promise.reject(new Error("Research module is not active")),
    history: () => active ? active.history() : Promise.reject(new Error("Research module is not active")),
    call: (actor, name, input, signal) => service ? service.call(actor, name, input, signal) : Promise.reject(new Error("Research module is not active")),
    mcp: (authenticate) => (request) => service ? createResearchMcp({ service, authenticate })(request) : Promise.resolve(new Response("Research module unavailable", { status: 503 })),
    tools,
    open(context) {
      if (opened) throw new Error("Research module resource already opened")
      opened = true
      const conversation = context.client.rpc(ConversationBackend.Api)
      active = createOwner({ ...options, primitives: options.primitives ?? [], storage: context.storage,
        deliver: async (target, id, text) => {
          if (target.backendID !== "opencode") return json(await conversation.send({ ref: target, inputID: id, text, delivery: "queue" }))
          const receipt = await context.client.session.prompt({ sessionID: target.threadID, id, text, delivery: "queue" })
          return json({ status: "accepted", ref: target, inputID: id, receipt: { nativeID: receipt.id, kind: "queued" } })
        },
      })
      service = researchService(active, async (actor) => {
        if (actor.backendID === "opencode") { await context.client.session.get({ sessionID: actor.threadID }); return }
        await conversation.execution({ ref: actor, limit: 1 })
      })
      tools.push(...service.tools)
      context.capability.report({ phase: "ready" })
      ready.resolve()
      return {
        async close() {
          const dispatcher = active
          const port = service
          active = undefined
          service = undefined
          const draining = port?.close()
          await dispatcher?.close()
          await draining
        },
      }
    },
  }
  return module
}
