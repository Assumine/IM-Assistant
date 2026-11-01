import type { Definition } from "../../../opencode/packages/plugin/src/effect/conversation"
import type { ConversationBackend } from "../../../opencode/packages/schema/src/conversation-backend"
import type { CodexSessionAdapter, Thread, ItemEntry } from "./session-adapter"
import { NativeError } from "./connection"
import { nativeContent } from "./content"
import { nativeQuestions } from "./questions"

// Native responses are JSON-RPC values. The host's public RPC schema validates them again.
const json = async (response: Promise<unknown>) => await response as Awaited<ReturnType<Definition["create"]>>

export function nativeBackend(adapter: CodexSessionAdapter): Definition {
  if (adapter.runtimeInfo().mode !== "shared") throw new Error("Managed backend requires the shared native service")
  const descriptor = { id: "codex-native", label: "Codex", browse: true, execution: true, create: true, images: true }
  const content = nativeContent(adapter, descriptor.id)
  const questions = nativeQuestions(adapter, descriptor.id)
  const owned = async (ref: ConversationBackend.Ref) => {
    if (ref.backendID !== descriptor.id) throw new Error("Different native backend")
    return adapter.readOwned(ref.threadID)
  }
  const locate = async (ref: ConversationBackend.Ref, inputID: string, terminal: boolean): Promise<ConversationBackend.InputPosition> => {
    await owned(ref)
    const positions: ConversationBackend.InputPosition[] = []
    const pages = async <T>(read: (cursor?: string) => Promise<{ data: T[]; nextCursor: string | null }>, each: (item: T) => void) => {
      const seen = new Set<string>()
      let cursor: string | undefined
      do {
        const page = await read(cursor)
        page.data.forEach(each)
        cursor = page.nextCursor ?? undefined
        if (cursor && seen.has(cursor)) throw new Error("Repeated native input cursor")
        if (cursor) seen.add(cursor)
      } while (cursor)
    }
    await pages((cursor) => adapter.queue(ref.threadID, { cursor, limit: 100 }), (item) => {
      if (item.clientUserMessageId === inputID) positions.push({ ref, inputID, status: "queued", nativeID: item.id })
    })
    if (positions.length > 1) throw new Error("Ambiguous native input identity")
    // A pending observation never authorizes steering; preserve the cheap original queue receipt lookup.
    if (positions[0]) return positions[0]
    await pages((cursor) => adapter.items(ref.threadID, undefined, { cursor, limit: 100 }), (entry) => {
      if (entry.item.type === "userMessage" && entry.item.clientId === inputID && typeof entry.item.id === "string")
        positions.push({ ref, inputID, status: "delivered", nativeID: entry.item.id, turnID: entry.turnId })
    })
    if (positions.length > 1) throw new Error("Ambiguous native input identity")
    const found = positions.at(0)
    if (!found || found.status !== "delivered" || !terminal) return found ?? { ref, inputID, status: "unknown" }
    const turns: { id: string; status: string }[] = []
    await pages((cursor) => adapter.turnStates(ref.threadID, { cursor, limit: 100 }), (turn) => {
      if (turn.id === found.turnID) turns.push(turn)
    })
    if (turns.length > 1) throw new Error("Ambiguous native input turn")
    const state = turns[0]?.status
    if (state === "inProgress") return found
    if (state === "completed" || state === "interrupted" || state === "failed") return { ...found, status: "closed", state }
    return { ref, inputID, status: "unknown" }
  }
  const input = (ref: ConversationBackend.Ref, inputID: string) => locate(ref, inputID, true)
  return {
    descriptor,
    input,
    output: async (ref, inputID) => {
      const position = await input(ref, inputID)
      if (position.status === "unknown" || position.status === "queued") return { ref, inputID, status: position.status }
      const items: ItemEntry[] = [], cursors = new Set<string>()
      let cursor: string | undefined
      do {
        const page = await adapter.items(ref.threadID, position.turnID, { cursor, limit: 100 })
        if (page.data.some((entry) => entry.turnId !== position.turnID)) throw new Error("Different native output turn")
        items.push(...page.data)
        cursor = page.nextCursor ?? undefined
        if (cursor && cursors.has(cursor)) throw new Error("Repeated native output cursor")
        if (cursor) cursors.add(cursor)
      } while (cursor)
      const users = items.filter((entry) => entry.item.type === "userMessage")
      const rootID = users[0]?.item.clientId
      if (typeof rootID !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(rootID) ||
        users.filter((entry) => entry.item.clientId === inputID && entry.item.id === position.nativeID).length !== 1)
        return { ref, inputID, status: "unknown" }
      const replies: ConversationBackend.OutputReply[] = items.flatMap((entry) => {
        const item = entry.item
        if (item.type !== "agentMessage") return []
        if (typeof item.id !== "string" || typeof item.text !== "string") throw new Error("Invalid native output item")
        const settled = typeof entry.completedAtMs === "number" && Number.isFinite(entry.completedAtMs) ||
          position.status === "closed" && position.state === "completed"
        return [{ messageID: item.id, text: settled ? item.text : "", settled }]
      })
      const first = replies.find((reply) => reply.settled && reply.text.trim()), last = replies.at(-1)
      const boundary = { ref, inputID, rootID, turnID: position.turnID, ...(first ? { first } : {}), ...(last ? { last } : {}) }
      return position.status === "closed" ? { ...boundary, status: "closed", state: position.state } : { ...boundary, status: "open" }
    },
    followup: async (request) => {
      if (request.inputID === request.followupOf.inputID) return { status: "rejected", reason: "not-accepted" }
      const valid = async () => {
        const parent = await input(request.ref, request.followupOf.inputID)
        return parent.status === "closed" && parent.turnID === request.followupOf.turnID && parent.nativeID === request.followupOf.nativeID
      }
      if (!await valid()) return { status: "rejected", reason: "not-accepted" }
      const thread = await owned(request.ref)
      if (thread.status.type === "notLoaded") {
        await adapter.resume(request.ref.threadID)
        if (!await valid()) return { status: "rejected", reason: "not-accepted" }
      }
      // Native queue/add cannot atomically fence the historical parent. This validates an observed terminal fact,
      // then adds a new independent input; it does not edit the parent, interrupt a successor or claim atomicity.
      const result = await adapter.enqueue(request.ref.threadID, request.inputID, request.text, ...(request.files?.length ? [request.files] as const : [] as const))
      return { kind: "queued", nativeID: result.queuedSubmission.id }
    },
    content: { subscribe: content.subscribe },
    execution: {
      read: async (ref, pagination) => {
        if (ref.backendID !== descriptor.id) throw new Error("Different native backend")
        const snapshot = await adapter.execution(ref.threadID, pagination)
        return {
          thread: threadView(snapshot.thread, descriptor.id),
          turn: snapshot.turn && { id: snapshot.turn.id, state: snapshot.turn.status === "inProgress" ? "running" : snapshot.turn.status },
          queue: snapshot.queue.data.map((submission) => ({
            nativeID: submission.id, inputID: submission.clientUserMessageId, ...inputView(submission.input),
          })),
          nextCursor: snapshot.queue.nextCursor ?? undefined,
          questions: questions.snapshot(ref.threadID),
        }
      },
      subscribe: (listener) => {
        const unsubscribeQuestions = questions.subscribe(listener)
        let closed = false
        const unsubscribe = adapter.subscribe((event) => {
          const change = activity(event.method)
          const threadID = event.params.threadId
          if (!change || typeof threadID !== "string") return
          // Metadata only; never forward another workspace's events or resume on observation.
          void adapter.readOwned(threadID).then(() => {
            if (!closed) listener({ ref: { backendID: descriptor.id, threadID }, change })
          }, () => undefined)
        })
        return () => { closed = true; unsubscribe(); unsubscribeQuestions() }
      },
    },
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
          content: content.snapshot(ref.threadID),
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
    create: async () => ({ thread: threadView((await adapter.create()).thread, descriptor.id) }),
    query: async (query) => {
      if ("threadID" in query) await adapter.readOwned(query.threadID)
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
    control: async (control) => {
      await adapter.readOwned(control.threadID)
      switch (control.action) {
        case "answer": return questions.respond(control.threadID, control.questionID, control.answers)
        case "dismiss-question": return questions.respond(control.threadID, control.questionID)
        case "withdraw": return { status: (await adapter.withdraw(control.threadID, control.nativeID)).deleted ? "applied" : "not-found" }
        case "guide": await adapter.guide(control.threadID, control.nativeID); break
        case "update": await adapter.update(control.threadID, control.nativeID, control.text); break
        case "reorder": await adapter.reorder(control.threadID, [...control.nativeIDs]); break
        case "interrupt": await adapter.interrupt(control.threadID, control.turnID); break
        case "compact": await adapter.compact(control.threadID); break
      }
      return { status: "applied" }
    },
    enqueue: async (input) => {
      if (input.delivery !== "steer" && input.followupOf) throw new Error("Linked input requires native follow-up admission")
      const thread = await owned(input.ref)
      if (input.delivery === "steer") {
        const result = await adapter.steer(input.ref.threadID, input.expectedTurnID, input.inputID, input.text, ...(input.files?.length ? [input.files] as const : [] as const)).catch((error) => {
          // The pinned native protocol rejects invalid requests/parameters before accepting guidance.
          // Internal errors and transport loss remain unknown; never infer rejection from error prose.
          if (error instanceof NativeError && (error.code === -32600 || error.code === -32602)) return undefined
          throw error
        })
        if (!result) return { status: "rejected", reason: "not-accepted" }
        return { nativeID: result.turnId, kind: "steered" }
      }
      // A persisted, unloaded thread accepts queue/add but cannot drain until an explicit resume.
      // Only a newly admitted user send reaches here; browsing and reconciliation remain read-only.
      if (thread.status.type === "notLoaded") await adapter.resume(input.ref.threadID)
      const result = await adapter.enqueue(input.ref.threadID, input.inputID, input.text, ...(input.files?.length ? [input.files] as const : [] as const))
      return { nativeID: result.queuedSubmission.id, kind: "queued" }
    },
    reconcile: async (ref, inputID) => {
      const position = await locate(ref, inputID, false)
      if (position.status !== "unknown") return { nativeID: position.nativeID, kind: position.status === "queued" ? "queued" : "message" }
    },
    subscribe: (listener) => adapter.subscribe((event) => {
      // Text fragments have their own scoped, offset-aware projection, not a duplicate raw public event.
      if (event.method !== "item/agentMessage/delta") listener(event as unknown as Awaited<ReturnType<Definition["create"]>>)
    }),
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
    return { ...base, kind: "user", ...inputView(item.content) }
  }
  // Preserve the record's identity and position; unsupported activity never becomes an invented assistant reply.
  return { ...base, kind: "activity", text: "", partial: true }
}

function inputView(parts: readonly unknown[]) {
  const texts: string[] = []
  let partial = false
  for (const part of parts) {
    if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string") texts.push(part.text)
    else partial = true
  }
  return { text: texts.join("\n"), partial }
}

function activity(method: string): ConversationBackend.Activity["change"] | undefined {
  switch (method) {
    case "thread/queue/changed":
    case "thread/status/changed": return "execution"
    case "turn/started":
    case "turn/completed": return "both"
    case "item/completed":
    case "thread/name/updated": return "history"
  }
}
