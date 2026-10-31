import { Transport, type Launch, type Notification } from "./transport"
import type { Connection } from "./connection"

export interface Thread {
  id: string
  turns: Record<string, unknown>[]
  [key: string]: unknown
}
export interface Submission {
  id: string
  clientUserMessageId: string
  input: Record<string, unknown>[]
}
export interface Page<T> {
  data: T[]
  nextCursor: string | null
}
export interface ItemEntry {
  item: Record<string, unknown>
  turnId: string
  [key: string]: unknown
}
interface Pagination { cursor?: string; limit?: number }
export interface Account {
  account: { type: string; email?: string | null; planType?: string } | null
  requiresOpenaiAuth: boolean
}

function id(value: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("Invalid native identifier")
  return value
}
function input(text: string) {
  if (typeof text !== "string" || !text.trim()) throw new Error("Text input required")
  return [{ type: "text", text }]
}
function page(value: Pagination) {
  if (value.limit !== undefined && (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > 100)) throw new Error("Invalid page size")
  if (value.cursor !== undefined && typeof value.cursor !== "string") throw new Error("Invalid cursor")
  return { cursor: value.cursor, limit: value.limit }
}

// A whole native backend. Nothing is passed to OpenCode Session.prompt, Inbox or model providers.
export class CodexSessionAdapter {
  private constructor(private native: Connection, private workspace: string) {}

  static async open(options: Launch) {
    return new CodexSessionAdapter(await Transport.open(options), options.profile.workspace)
  }

  subscribe(listener: (event: Notification) => void) { return this.native.subscribe(listener) }
  runtimeInfo() { return this.native.info() }
  onClose(listener: () => void) { return this.native.onClose(listener) }
  close() { return this.native.close() }

  create() {
    return this.native.request<{ thread: Thread }>("thread/start", {
      cwd: this.workspace, sandbox: "read-only", approvalPolicy: "never", environments: [], dynamicTools: [],
    })
  }
  resume(threadId: string) {
    return this.native.request<{ thread: Thread }>("thread/resume", {
      threadId: id(threadId), excludeTurns: true, cwd: this.workspace, sandbox: "read-only", approvalPolicy: "never",
    })
  }
  read(threadId: string) {
    return this.native.request<{ thread: Thread }>("thread/read", { threadId: id(threadId), includeTurns: false })
  }
  list(pagination: Pagination = {}) {
    return this.native.request<Page<Thread>>("thread/list", { ...page(pagination), cwd: this.workspace })
  }
  turns(threadId: string, pagination: Pagination = {}) {
    return this.native.request<Page<Record<string, unknown>>>("thread/turns/list", {
      threadId: id(threadId), ...page(pagination), itemsView: "full", sortDirection: "desc",
    })
  }
  items(threadId: string, turnId?: string, pagination: Pagination = {}) {
    return this.native.request<Page<ItemEntry>>("thread/items/list", {
      threadId: id(threadId), turnId: turnId === undefined ? undefined : id(turnId), ...page(pagination), sortDirection: "asc",
    })
  }
  enqueue(threadId: string, clientUserMessageId: string, text: string) {
    return this.native.request<{ queuedSubmission: Submission }>("thread/queue/add", {
      threadId: id(threadId), clientUserMessageId: id(clientUserMessageId), input: input(text),
    })
  }
  queue(threadId: string, pagination: Pagination = {}) {
    return this.native.request<Page<Submission>>("thread/queue/list", { threadId: id(threadId), ...page(pagination) })
  }
  update(threadId: string, submissionId: string, text: string) {
    return this.native.request<{ queuedSubmission: Submission }>("thread/queue/update", {
      threadId: id(threadId), queuedSubmissionId: id(submissionId), input: input(text),
    })
  }
  withdraw(threadId: string, submissionId: string) {
    return this.native.request<{ deleted: boolean }>("thread/queue/delete", { threadId: id(threadId), queuedSubmissionId: id(submissionId) })
  }
  reorder(threadId: string, submissionIds: string[]) {
    if (!Array.isArray(submissionIds) || new Set(submissionIds).size !== submissionIds.length) throw new Error("Invalid queue order")
    return this.native.request<Record<string, never>>("thread/queue/reorder", {
      threadId: id(threadId), queuedSubmissionIds: submissionIds.map(id),
    })
  }
  // Explicit user action only; the native queue already drains automatically.
  guide(threadId: string, submissionId: string) {
    return this.native.request<{ turn: Record<string, unknown> }>("thread/queue/start", { threadId: id(threadId), queuedSubmissionId: id(submissionId) })
  }
  steer(threadId: string, expectedTurnId: string, clientUserMessageId: string, text: string) {
    return this.native.request<{ turnId: string }>("turn/steer", {
      threadId: id(threadId), expectedTurnId: id(expectedTurnId), clientUserMessageId: id(clientUserMessageId), input: input(text),
    })
  }
  interrupt(threadId: string, turnId: string) {
    return this.native.request<Record<string, never>>("turn/interrupt", { threadId: id(threadId), turnId: id(turnId) })
  }
  compact(threadId: string) {
    return this.native.request<Record<string, never>>("thread/compact/start", { threadId: id(threadId) })
  }
  account() { return this.native.request<Account>("account/read", { refreshToken: false }) }
  login() {
    return this.native.request<{ type: "chatgpt"; loginId: string; authUrl: string }>("account/login/start", {
      type: "chatgpt", useHostedLoginSuccessPage: true, appBrand: "codex",
    })
  }
  cancelLogin(loginId: string) {
    return this.native.request<{ status: "canceled" | "notFound" }>("account/login/cancel", { loginId: id(loginId) })
  }
  models(pagination: Pagination = {}) {
    return this.native.request<Page<Record<string, unknown>>>("model/list", page(pagination))
  }
}
