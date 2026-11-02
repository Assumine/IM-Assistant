import type { ApplicationModule } from "../../../opencode/packages/plugin/src/promise/application"
import type { Info } from "../../../opencode/packages/plugin/src/promise/tool"
import { createOwner } from "./owner"
import { researchService } from "./service"
import { createResearchMcp } from "./mcp"
import { researchView } from "./presentation"
import type { Caller, Primitive } from "./contracts"
import { json } from "./contracts"
import { ConversationBackend } from "../../../opencode/packages/schema/src/conversation-backend"
import type { Data, ResearchInput, ResearchPath, Scoring } from "./types"

/** Optional application capability. Native Session/Inbox remain the owners of AI tasks. */
export function createResearchModule(options: { paths?: readonly ResearchPath[]; primitives?: readonly Primitive[]; scoring?: Partial<Scoring> }) {
  const ready = Promise.withResolvers<void>()
  // A caller may only use the native tool surface and never await the MCP startup.
  void ready.promise.catch(() => {})
  let active: ReturnType<typeof createOwner> | undefined
  let service: ReturnType<typeof researchService> | undefined
  const tools: Info[] = []
  let refresh: (() => Promise<void>) | undefined
  let opened = false
  const module: ApplicationModule & {
    ready: Promise<void>
    run: ReturnType<typeof createOwner>["run"]
    history: ReturnType<typeof createOwner>["history"]
    call: (actor: Caller, name: string, input: unknown, signal?: AbortSignal) => Promise<Data>
    mcp: (authenticate: (token: string) => Promise<Caller | undefined>) => (request: Request) => Promise<Response>
  } = {
    id: "research", title: "Research scripts", ready: ready.promise,
    run: (request) => active ? active.run(request) : Promise.reject(new Error("Research module is not active")),
    history: async () => { if (!active) throw new Error("Research module is not active"); await refresh?.(); return active.history() },
    call: (actor, name, input, signal) => service ? service.call(actor, name, input, signal) : Promise.reject(new Error("Research module is not active")),
    mcp: (authenticate) => (request) => service ? createResearchMcp({ service, authenticate })(request) : Promise.resolve(new Response("Research module unavailable", { status: 503 })),
    tools,
    open(context) {
      if (opened) throw new Error("Research module resource already opened")
      opened = true
      const controller = new AbortController()
      const conversation = context.client.rpc(ConversationBackend.Api)
      async function observe(input: ResearchInput): Promise<"open" | "completed" | "cancelled" | "uncertain"> {
        if (input.backendID === "opencode") {
          const position = await context.client.session.input.position({ sessionID: input.threadID, inputID: input.inputID })
          if (position.rootID !== input.inputID) return "uncertain"
          if (position.status === "open") return "open"
          const outcome = position.status === "closed" ? position.experimental?.outcome : undefined
          return outcome === "completed" ? "completed" : outcome === "interrupted" ? "cancelled" : "uncertain"
        }
        const position = await conversation.output({ ref: { backendID: input.backendID, threadID: input.threadID }, inputID: input.inputID })
        if (position.status === "open" && position.rootID === input.inputID) return "open"
        if (position.status === "closed" && position.rootID === input.inputID) return position.state === "completed" ? "completed" : position.state === "interrupted" ? "cancelled" : "uncertain"
        return "uncertain"
      }
      let connected = false
      active = createOwner({ ...options, primitives: options.primitives ?? [], storage: context.storage,
        changed: () => context.capability.invalidate?.(),
        describeInput: async (input) => {
          if (input.backendID !== "opencode") {
            const execution = await conversation.execution({ ref: input, limit: 1 })
            return { goal: "Research", conversation: execution.thread.title }
          }
          const [message, session] = await Promise.all([
            context.client.session.message.get({ sessionID: input.threadID, messageID: input.inputID }),
            context.client.session.get({ sessionID: input.threadID }),
          ])
          const text = message.type === "user" ? message.text : ""
          const goal = text.trim().split(/\r?\n/).find(Boolean)?.replace(/\s+/g, " ").slice(0, 160) || session.title || "Research"
          return { goal, conversation: session.title }
        },
        isOpen: async (input) => connected && await observe(input) === "open",
        deliver: async (target, id, text) => {
          if (target.backendID !== "opencode") return json(await conversation.send({ ref: target, inputID: id, text, delivery: "queue" }))
          const receipt = await context.client.session.prompt({ sessionID: target.threadID, id, text, delivery: "queue" })
          return json({ status: "accepted", ref: target, inputID: id, receipt: { nativeID: receipt.id, kind: "queued" } })
        },
      })
      const owner = active
      async function reconcile(sessionID?: string, rootID?: string) {
        for (const input of await owner.pending()) {
          if (sessionID !== undefined && (input.backendID !== "opencode" || input.threadID !== sessionID || rootID !== undefined && input.inputID !== rootID)) continue
          const state = await observe(input)
          if (state !== "open") await owner.finish(input, state)
        }
      }
      refresh = reconcile
      service = researchService(active, async (actor) => {
        if (actor.backendID === "opencode") { await context.client.session.get({ sessionID: actor.threadID }); return }
        await conversation.execution({ ref: actor, limit: 1 })
      }, async (caller, messageID) => {
        if (!connected) throw new Error("Research native lifecycle observation is unavailable")
        let inputID = caller.inputID
        if (messageID) {
          const message = await context.client.session.message.get({ sessionID: caller.threadID, messageID })
          if (message.type !== "assistant" || !message.inputRootID) throw new Error("Research tool has no proven native input owner")
          inputID = message.inputRootID
        }
        if (!inputID) throw new Error("Research MCP host must bind the original native input ID")
        if (caller.backendID === "opencode") {
          const position = await context.client.session.input.position({ sessionID: caller.threadID, inputID })
          if (!position.rootID || !["open", "closed"].includes(position.status)) throw new Error("Research input is not natively delivered")
          inputID = position.rootID
        } else {
          const position = await conversation.output({ ref: { backendID: caller.backendID, threadID: caller.threadID }, inputID })
          if (position.status !== "open" && position.status !== "closed") throw new Error("Research input ownership is unproven")
          if (position.rootID !== inputID) throw new Error("Research MCP host must bind the canonical original input ID")
        }
        const input = { backendID: caller.backendID, threadID: caller.threadID, inputID }
        // Reconcile once at a requested boundary. This never polls or starts native work.
        await reconcile()
        return input
      })
      tools.push(...service.tools)
      const observing = (async () => {
        try {
          for await (const event of context.client.event.subscribe({ signal: controller.signal,
            types: ["session.input.closed", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"] })) {
            if (controller.signal.aborted) break
            if (event.type === "server.connected") { connected = true; await reconcile(); context.capability.report({ phase: "ready" }); ready.resolve(); continue }
            if (event.type === "session.input.closed") { await reconcile(event.data.sessionID, event.data.rootID); continue }
            if (event.type === "session.execution.interrupted" && event.data.reason === "shutdown") continue
            if ("sessionID" in event.data) await reconcile(event.data.sessionID)
          }
        } catch { /* Failure is reported once below, without exposing transport details. */ }
        finally {
          connected = false
          if (!controller.signal.aborted) context.capability.report({ phase: "unavailable", message: "Research lifecycle observation is unavailable" })
          ready.reject(new Error("Research lifecycle observation ended"))
        }
      })()
      return {
        async view(input) {
          if (!connected) throw new Error("Research lifecycle observation is unavailable")
          await reconcile()
          const role = await owner.role()
          const title = role.holder ? role.holder.backendID === "opencode"
            ? (await context.client.session.get({ sessionID: role.holder.threadID })).title
            : (await conversation.execution({ ref: role.holder, limit: 1 })).thread.title : undefined
          return researchView(owner, input, title)
        },
        async close() {
          controller.abort()
          ready.reject(new Error("Research module stopped"))
          const dispatcher = active
          const port = service
          active = undefined
          service = undefined
          refresh = undefined
          const draining = port?.close()
          await dispatcher?.close()
          await draining
          await observing
        },
      }
    },
  }
  return module
}
