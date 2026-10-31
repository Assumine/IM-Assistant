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
  readonly reconcile: (ref: ConversationBackend.Ref, inputID: string) => Promise<ConversationBackend.Receipt | undefined>
  readonly subscribe: (listener: (notification: Schema.Json) => void) => () => void
}

export interface ConversationDomain {
  readonly register: (backend: Definition) => Effect.Effect<Registration, unknown, Scope.Scope>
}
