import { randomUUID } from "node:crypto"
import type { ConversationBackend } from "../../../opencode/packages/schema/src/conversation-backend"
import type { CodexSessionAdapter } from "./session-adapter"
import type { Notification } from "./connection"

// A live-connection text projection only. No completed history, replay log or execution state is persisted here.
export function nativeContent(adapter: CodexSessionAdapter, backendID: string) {
  let streamID = randomUUID()
  const listeners = new Set<(event: ConversationBackend.Content) => void>()
  const turns = new Map<string, { id: string; approved: boolean; items: Map<string, ConversationBackend.Entry> }>()
  let detach: (() => void) | undefined
  const emit = (event: ConversationBackend.Content) => { for (const listener of listeners) listener(event) }
  const snapshot = (threadID: string, entry: ConversationBackend.Entry, done: boolean) =>
    emit({ type: "snapshot", ref: { backendID, threadID }, streamID, entry, done })
  const receive = (event: Notification) => {
    const threadID = event.params.threadId
    if (typeof threadID !== "string") return
    if (event.method === "turn/started") {
      const turn = event.params.turn
      if (!turn || typeof turn !== "object" || !("id" in turn) || typeof turn.id !== "string") return
      const active = { id: turn.id, approved: false, items: new Map<string, ConversationBackend.Entry>() }
      turns.set(threadID, active)
      // One ownership check per turn, never a thread/database read for every text fragment.
      void adapter.readOwned(threadID).then(() => {
        if (turns.get(threadID) !== active) return
        active.approved = true
        for (const entry of active.items.values()) snapshot(threadID, entry, false)
      }, () => { if (turns.get(threadID) === active) turns.delete(threadID) })
      return
    }
    const active = turns.get(threadID)
    if (!active) return
    if (event.method === "turn/completed") {
      const turn = event.params.turn
      if (turn && typeof turn === "object" && "id" in turn && turn.id === active.id) turns.delete(threadID)
      return
    }
    if (event.params.turnId !== active.id) return
    if (event.method === "item/started" || event.method === "item/completed") {
      const item = event.params.item
      if (!item || typeof item !== "object" || !("type" in item) || item.type !== "agentMessage" ||
        !("id" in item) || typeof item.id !== "string" || !("text" in item) || typeof item.text !== "string") return
      const done = event.method === "item/completed"
      if (!done && active.items.has(item.id)) return
      const entry: ConversationBackend.Entry = { id: item.id, turnID: active.id, kind: "assistant", text: item.text, partial: false }
      if (done) active.items.delete(item.id)
      else active.items.set(item.id, entry)
      if (active.approved) snapshot(threadID, entry, done)
      return
    }
    if (event.method !== "item/agentMessage/delta" || typeof event.params.itemId !== "string" || typeof event.params.delta !== "string") return
    const entry = active.items.get(event.params.itemId)
    // A connection attached mid-message cannot reconstruct an unknown prefix. Final native history remains available.
    if (!entry) return
    const offset = entry.text.length
    active.items.set(entry.id, { ...entry, text: entry.text + event.params.delta })
    if (active.approved) emit({ type: "append", ref: { backendID, threadID }, streamID, turnID: active.id, itemID: entry.id, offset, text: event.params.delta })
  }
  return {
    snapshot(threadID: string) {
      const turn = turns.get(threadID)
      return { streamID, items: turn?.approved ? [...turn.items.values()] : [] }
    },
    subscribe(listener: (event: ConversationBackend.Content) => void) {
      listeners.add(listener)
      if (!detach) { streamID = randomUUID(); detach = adapter.subscribe(receive) }
      return () => {
        listeners.delete(listener)
        if (listeners.size) return
        detach?.()
        detach = undefined
        turns.clear()
      }
    },
  }
}
