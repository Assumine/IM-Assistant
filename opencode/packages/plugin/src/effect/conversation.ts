import type { ConversationBackend } from "@opencode/schema/conversation-backend"
import type { Effect, Schema, Scope } from "effect"
import type { Registration } from "./registration.js"

// A complete backend, not a provider model. Native payloads and IDs are not rewritten.
// The application owns admission receipts; the backend alone owns pending/executing work.
export interface Definition {
  readonly descriptor: ConversationBackend.Descriptor
  readonly create: () => Promise<Schema.Json>
  readonly query: (query: ConversationBackend.Query) => Promise<Schema.Json>
  readonly control: (control: ConversationBackend.Control) => Promise<Schema.Json>
  readonly enqueue: (input: ConversationBackend.Input) => Promise<ConversationBackend.Receipt>
  readonly reconcile: (
    ref: ConversationBackend.Ref,
    inputID: string,
  ) => Promise<ConversationBackend.Receipt | undefined>
  readonly subscribe: (listener: (notification: Schema.Json) => void) => () => void
  readonly onClose?: (listener: () => void) => () => void
  // Optional native run/queue projection; observers never own execution or automatically replay controls.
  readonly execution?: {
    readonly read: (
      ref: ConversationBackend.Ref,
      page: { cursor?: string; limit?: number },
    ) => Promise<ConversationBackend.Execution>
    readonly subscribe: (listener: (event: ConversationBackend.Activity) => void) => () => void
  }
  // Optional read-only UI projection. Reading must not resume a thread or admit work.
  readonly browse?: {
    readonly threads: (page: { cursor?: string; limit?: number }) => Promise<ConversationBackend.Threads>
    readonly history: (
      ref: ConversationBackend.Ref,
      page: { cursor?: string; limit?: number },
    ) => Promise<ConversationBackend.History>
  }
  // Optional native sign-in ceremony. The backend retains all tokens and refresh/expiry logic.
  readonly authentication?: {
    readonly read: () => Promise<ConversationBackend.Account>
    readonly start: () => Promise<ConversationBackend.BrowserLogin>
    readonly cancel: (loginID: string) => Promise<"canceled" | "not-found">
    readonly subscribe: (listener: (event: ConversationBackend.AuthenticationEvent) => void) => () => void
  }
}

export interface ConversationDomain {
  readonly register: (backend: Definition) => Effect.Effect<Registration, unknown, Scope.Scope>
}
