import type { Definition } from "../../../opencode/packages/plugin/src/effect/conversation"
import type { CodexSessionAdapter } from "./session-adapter"

// Native responses are JSON-RPC values. The host's public RPC schema validates them again.
const json = async (response: Promise<unknown>) => await response as Awaited<ReturnType<Definition["create"]>>

export function nativeBackend(adapter: CodexSessionAdapter): Definition {
  if (adapter.runtimeInfo().mode !== "shared") throw new Error("Managed backend requires the shared native service")
  return {
    descriptor: { id: "codex-native", label: "Codex" },
    create: () => json(adapter.create()),
    query: (query) => {
      switch (query.action) {
        case "list": return json(adapter.list(query))
        case "account": return json(adapter.account())
        case "models": return json(adapter.models())
        case "resume": return json(adapter.resume(query.threadID))
        case "read": return json(adapter.read(query.threadID))
        case "queue": return json(adapter.queue(query.threadID, query))
        case "history": return json(adapter.turns(query.threadID, query))
      }
    },
    control: (control) => {
      switch (control.action) {
        case "withdraw": return json(adapter.withdraw(control.threadID, control.nativeID))
        case "guide": return json(adapter.guide(control.threadID, control.nativeID))
        case "update": return json(adapter.update(control.threadID, control.nativeID, control.text))
        case "reorder": return json(adapter.reorder(control.threadID, [...control.nativeIDs]))
        case "interrupt": return json(adapter.interrupt(control.threadID, control.turnID))
        case "compact": return json(adapter.compact(control.threadID))
      }
    },
    enqueue: async (input) => {
      if (input.delivery === "steer") {
        const result = await adapter.steer(input.ref.threadID, input.expectedTurnID, input.inputID, input.text)
        return { nativeID: result.turnId, kind: "steered" }
      }
      const result = await adapter.enqueue(input.ref.threadID, input.inputID, input.text)
      return { nativeID: result.queuedSubmission.id, kind: "queued" }
    },
    reconcile: async (ref, inputID) => {
      const queued = []
      let cursor: string | undefined
      do {
        const page = await adapter.queue(ref.threadID, { cursor, limit: 100 })
        queued.push(...page.data.filter((item) => item.clientUserMessageId === inputID))
        cursor = page.nextCursor ?? undefined
      } while (cursor)
      if (queued.length > 1) throw new Error("Ambiguous native submissions")
      if (queued[0]) return { nativeID: queued[0].id, kind: "queued" }
      const messages = []
      do {
        const page = await adapter.items(ref.threadID, undefined, { cursor, limit: 100 })
        messages.push(...page.data.map((entry) => entry.item).filter((item) => item.type === "userMessage" && item.clientId === inputID))
        cursor = page.nextCursor ?? undefined
      } while (cursor)
      if (messages.length > 1) throw new Error("Ambiguous native messages")
      if (typeof messages[0]?.id === "string") return { nativeID: messages[0].id, kind: "message" }
    },
    subscribe: (listener) => adapter.subscribe((event) => listener(event as unknown as Awaited<ReturnType<Definition["create"]>>)),
    onClose: (listener) => adapter.onClose(listener),
  }
}
