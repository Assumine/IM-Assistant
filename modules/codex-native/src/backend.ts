import type { Definition } from "../../../opencode/packages/plugin/src/effect/conversation"
import type { ConversationBackend } from "../../../opencode/packages/schema/src/conversation-backend"
import type { CodexSessionAdapter, Thread, ItemEntry } from "./session-adapter"

// Native responses are JSON-RPC values. The host's public RPC schema validates them again.
const json = async (response: Promise<unknown>) => await response as Awaited<ReturnType<Definition["create"]>>

export function nativeBackend(adapter: CodexSessionAdapter): Definition {
  if (adapter.runtimeInfo().mode !== "shared") throw new Error("Managed backend requires the shared native service")
  const descriptor = { id: "codex-native", label: "Codex", browse: true }
  return {
    descriptor,
    browse: {
      threads: async (pagination) => {
        const page = await adapter.list(pagination)
        return { items: page.data.map((thread) => threadView(thread, descriptor.id)), nextCursor: page.nextCursor ?? undefined }
      },
      history: async (ref, pagination) => {
        const page = await adapter.history(ref.threadID, pagination)
        return {
          thread: threadView(page.thread, descriptor.id),
          items: page.data.map(entryView).reverse(),
          nextCursor: page.nextCursor ?? undefined,
        }
      },
    },
    authentication: {
      read: async () => {
        const current = await adapter.account()
        if (!current.account) return { state: current.requiresOpenaiAuth ? "signed-out" : "not-required" }
        return {
          state: "signed-in",
          ...(current.account.email ? { label: current.account.email } : {}),
          ...(current.account.planType ? { plan: current.account.planType } : {}),
        }
      },
      start: async () => {
        const current = await adapter.account()
        if (!current.requiresOpenaiAuth) throw new Error("The configured provider does not use native sign-in")
        const login = await adapter.login()
        return { id: login.loginId, url: login.authUrl }
      },
      cancel: async (loginID) => (await adapter.cancelLogin(loginID)).status === "canceled" ? "canceled" : "not-found",
      subscribe: (listener) => adapter.subscribe((event) => {
        if (event.method === "account/updated") listener({ type: "updated" })
        if (event.method === "account/login/completed" && typeof event.params.loginId === "string" && typeof event.params.success === "boolean") {
          listener({ type: "completed", loginID: event.params.loginId, success: event.params.success })
        }
      }),
    },
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

function threadView(thread: Thread, backendID: string): ConversationBackend.Thread {
  let state: ConversationBackend.Thread["state"] = "unknown"
  switch (thread.status.type) {
    case "active": state = thread.status.activeFlags?.length ? "waiting" : "running"; break
    case "idle": state = "idle"; break
    case "notLoaded": state = "unloaded"; break
    case "systemError": state = "error"; break
  }
  return { ref: { backendID, threadID: thread.id }, title: thread.name || thread.preview || thread.id, state, updatedAt: thread.updatedAt * 1000 }
}

function entryView(entry: ItemEntry): ConversationBackend.Entry {
  const item = entry.item
  if (typeof item.id !== "string") throw new Error("Native history item has no ID")
  const base = { id: item.id, turnID: entry.turnId, timestamp: entry.startedAtMs ?? entry.completedAtMs ?? undefined }
  if (item.type === "agentMessage" && typeof item.text === "string") return { ...base, kind: "assistant", text: item.text, partial: false }
  if (item.type === "userMessage" && Array.isArray(item.content)) {
    const texts: string[] = []
    const parts: unknown[] = item.content
    let partial = false
    for (const part of parts) {
      if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string") texts.push(part.text)
      else partial = true
    }
    return { ...base, kind: "user", text: texts.join("\n"), partial }
  }
  // Preserve the record's identity and position; unsupported activity never becomes an invented assistant reply.
  return { ...base, kind: "activity", text: "", partial: true }
}
