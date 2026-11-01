import { Transport, type Launch, type Notification } from "./transport"
import type { Connection } from "./connection"
import type { UserInputRequest } from "./connection"
import path from "node:path"
import { ConversationBackend } from "../../../opencode/packages/schema/src/conversation-backend"

export interface Thread {
  id: string
  cwd: string
  name?: string | null
  preview: string
  updatedAt: number
  status: { type: string; activeFlags?: string[] }
  turns: Record<string, unknown>[]
  [key: string]: unknown
}
export interface Submission {
  id: string
  clientUserMessageId: string
  input: Record<string, unknown>[]
}
export interface Turn {
  id: string
  status: "completed" | "interrupted" | "failed" | "inProgress"
}
export interface Page<T> {
  data: T[]
  nextCursor: string | null
}
export interface ItemEntry {
  item: Record<string, unknown>
  turnId: string
  startedAtMs?: number | null
  completedAtMs?: number | null
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
function input(text: string, files?: readonly ConversationBackend.ImageAttachment[]) {
  if (typeof text !== "string" || !text.trim() && !files?.length) throw new Error("Text input or inline image required")
  if (files && (files.length > 4 || !files.every(ConversationBackend.ImageAttachment.is))) throw new Error("Invalid inline image")
  return [...(text.trim() ? [{ type: "text", text }] : []), ...(files?.map((file) => ({ type: "image", url: file.uri })) ?? [])]
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
  onUserInput(listener: (request: UserInputRequest) => void) { return this.native.onUserInput(listener) }
  userInput(requestID: number | string) { return this.native.userInput(requestID) }
  answerUserInput(requestID: number | string, answers: Record<string, { answers: readonly string[] }>) {
    return this.native.answerUserInput(requestID, { answers })
  }
  rejectUserInput(requestID: number | string) { this.native.rejectUserInput(requestID) }

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
  async readOwned(threadId: string) {
    const { thread } = await this.read(threadId)
    if (path.relative(this.workspace, thread.cwd) !== "") throw new Error("Thread belongs to another workspace")
    return thread
  }
  list(pagination: Pagination = {}) {
    return this.native.request<Page<Thread>>("thread/list", { ...page(pagination), cwd: this.workspace })
  }
  turns(threadId: string, pagination: Pagination = {}) {
    return this.native.request<Page<Record<string, unknown>>>("thread/turns/list", {
      threadId: id(threadId), ...page(pagination), itemsView: "full", sortDirection: "desc",
    })
  }
  turnStates(threadId: string, pagination: Pagination = {}) {
    return this.native.request<Page<Turn>>("thread/turns/list", {
      threadId: id(threadId), ...page(pagination), itemsView: "notLoaded", sortDirection: "desc",
    })
  }
  items(threadId: string, turnId?: string, pagination: Pagination = {}) {
    return this.native.request<Page<ItemEntry>>("thread/items/list", {
      threadId: id(threadId), turnId: turnId === undefined ? undefined : id(turnId), ...page(pagination), sortDirection: "asc",
    })
  }
  async history(threadId: string, pagination: Pagination = {}) {
    const thread = await this.readOwned(threadId)
    const items = await this.native.request<Page<ItemEntry>>("thread/items/list", {
      threadId: id(threadId), ...page(pagination), sortDirection: "desc",
    })
    return { thread, ...items }
  }
  async execution(threadId: string, pagination: Pagination = {}) {
    const thread = await this.readOwned(threadId)
    const [turns, queue] = await Promise.all([
      this.native.request<Page<Turn>>("thread/turns/list", {
        threadId: id(threadId), limit: 1, itemsView: "notLoaded", sortDirection: "desc",
      }),
      this.queue(threadId, pagination),
    ])
    return { thread, turn: turns.data[0], queue }
  }
  enqueue(threadId: string, clientUserMessageId: string, text: string, files?: readonly ConversationBackend.ImageAttachment[]) {
    return this.native.request<{ queuedSubmission: Submission }>("thread/queue/add", {
      threadId: id(threadId), clientUserMessageId: id(clientUserMessageId), input: input(text, files),
    })
  }
  queue(threadId: string, pagination: Pagination = {}) {
    return this.native.request<Page<Submission>>("thread/queue/list", { threadId: id(threadId), ...page(pagination) })
  }
  async update(threadId: string, submissionId: string, text: string) {
    // Native update replaces the entire payload and has no compare-and-swap. Text-only editing must not erase images.
    let cursor: string | undefined
    const seen = new Set<string>()
    do {
      const page = await this.queue(threadId, { cursor, limit: 100 })
      const current = page.data.find((item) => item.id === submissionId)
      if (current?.input.some((part) => part.type !== "text")) throw new Error("Text-only editing of attachments is unavailable")
      if (current) break
      cursor = page.nextCursor ?? undefined
      if (cursor && seen.has(cursor)) throw new Error("Repeated native queue cursor")
      if (cursor) seen.add(cursor)
    } while (cursor)
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
  steer(threadId: string, expectedTurnId: string, clientUserMessageId: string, text: string, files?: readonly ConversationBackend.ImageAttachment[]) {
    return this.native.request<{ turnId: string }>("turn/steer", {
      threadId: id(threadId), expectedTurnId: id(expectedTurnId), clientUserMessageId: id(clientUserMessageId), input: input(text, files),
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
