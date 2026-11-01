import type { ConversationBackend } from "@opencode/schema/conversation-backend"
import type { Effect, Schema, Scope } from "effect"
import type { Registration } from "./registration.js"

// A complete backend, not a provider model. Native payloads and IDs are not rewritten.
// The application owns admission receipts; the backend alone owns pending/executing work.
export interface Definition {
  readonly descriptor: ConversationBackend.Descriptor
  // Explicit native creation only; preserve the native ID, without credentials, private paths or a first prompt.
  readonly create: () => Promise<ConversationBackend.Created>
  readonly query: (query: ConversationBackend.Query) => Promise<Schema.Json>
  readonly control: (control: ConversationBackend.Control) => Promise<ConversationBackend.ControlResult>
  // Rejection is permitted only when the native backend confirms non-acceptance. Ambiguous failures must throw.
  readonly enqueue: (
    input: ConversationBackend.Input,
  ) => Promise<ConversationBackend.Receipt | ConversationBackend.Rejection>
  // Optional native follow-up admission. Must revalidate the observed parent and retain the backend's own queue.
  readonly followup?: (
    input: ConversationBackend.FollowupInput,
  ) => Promise<ConversationBackend.Receipt | ConversationBackend.Rejection>
  readonly reconcile: (
    ref: ConversationBackend.Ref,
    inputID: string,
  ) => Promise<ConversationBackend.Receipt | undefined>
  // Read native pending/history identity without replaying admission, resuming or creating an input.
  readonly input?: (ref: ConversationBackend.Ref, inputID: string) => Promise<ConversationBackend.InputPosition>
  // Optional read-only first/latest public output with native input/root/turn proof. Never resumes a thread.
  readonly output?: (ref: ConversationBackend.Ref, inputID: string) => Promise<ConversationBackend.Output>
  readonly subscribe: (listener: (notification: Schema.Json) => void) => () => void
  readonly onClose?: (listener: () => void) => () => void
  // Optional ephemeral native text feed. Completed history still comes from browse.history.
  readonly content?: {
    readonly subscribe: (listener: (event: ConversationBackend.Content) => void) => () => void
  }
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

/** A trusted, complete backend module. Not serializable config, a model provider, or a remotely loadable plugin. */
export interface Module {
  readonly id: string
  /** Acquire a bounded native connection; clean up partial acquisition on failure. Never admit work during startup. */
  readonly open: () => Promise<{
    readonly backend: Definition
    /** Disconnect this host's connection only; native work and other clients retain their own lifecycle. */
    readonly close: () => Promise<void>
  }>
}
