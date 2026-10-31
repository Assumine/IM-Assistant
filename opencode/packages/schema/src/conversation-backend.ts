export * as ConversationBackend from "./conversation-backend.js"

import { Schema } from "effect"
import { Rpc } from "./rpc.js"
import { optional } from "./schema.js"

const ID = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/))
export const Ref = Schema.Struct({ backendID: ID, threadID: ID })
export type Ref = typeof Ref.Type
const fields = { ref: Ref, inputID: ID, text: Schema.String.check(Schema.isPattern(/\S/)) }
export const Input = Schema.Union([
  Schema.Struct({ ...fields, delivery: Schema.optional(Schema.Literal("queue")) }),
  Schema.Struct({ ...fields, delivery: Schema.Literal("steer"), expectedTurnID: ID }),
])
export type Input = typeof Input.Type
export const Receipt = Schema.Struct({ nativeID: ID, kind: Schema.Literals(["queued", "steered", "message"]) })
export type Receipt = typeof Receipt.Type
export const Admission = Schema.Union([
  Schema.Struct({ status: Schema.Literal("accepted"), ref: Ref, inputID: ID, receipt: Receipt }),
  Schema.Struct({ status: Schema.Literal("uncertain"), ref: Ref, inputID: ID }),
])
export type Admission = typeof Admission.Type
export const Page = {
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
}
export const Query = Schema.Union([
  Schema.Struct({ action: Schema.Literals(["resume", "read", "queue", "history"]), threadID: ID, ...Page }),
  Schema.Struct({ action: Schema.Literal("list"), ...Page }),
  Schema.Struct({ action: Schema.Literals(["account", "models"]) }),
])
export type Query = typeof Query.Type
export const Control = Schema.Union([
  Schema.Struct({ action: Schema.Literals(["withdraw", "guide"]), threadID: ID, nativeID: ID }),
  Schema.Struct({ action: Schema.Literal("update"), threadID: ID, nativeID: ID, text: Schema.String }),
  Schema.Struct({ action: Schema.Literal("reorder"), threadID: ID, nativeIDs: Schema.Array(ID) }),
  Schema.Struct({ action: Schema.Literal("interrupt"), threadID: ID, turnID: ID }),
  Schema.Struct({ action: Schema.Literal("compact"), threadID: ID }),
])
export type Control = typeof Control.Type
// An acknowledgement, never a replacement execution snapshot. Missing means a pending input already left the queue.
// Transport/backend failures remain errors with unknown effect; callers must not infer success or automatically retry.
export const ControlResult = Schema.Struct({ status: Schema.Literals(["applied", "not-found"]) })
export type ControlResult = typeof ControlResult.Type
export const Descriptor = Schema.Struct({
  id: ID,
  label: Schema.String,
  browse: optional(Schema.Boolean),
  execution: optional(Schema.Boolean),
})
export type Descriptor = typeof Descriptor.Type

// Read-only display projections. Native references and ordering remain backend-owned.
export const Thread = Schema.Struct({
  ref: Ref,
  title: Schema.String,
  state: Schema.Literals(["running", "waiting", "idle", "unloaded", "error", "unknown"]),
  updatedAt: optional(Schema.Number),
})
export type Thread = typeof Thread.Type
export const Threads = Schema.Struct({ items: Schema.Array(Thread), nextCursor: optional(Schema.String) })
export type Threads = typeof Threads.Type
export const Entry = Schema.Struct({
  id: ID,
  turnID: ID,
  kind: Schema.Literals(["user", "assistant", "activity"]),
  text: Schema.String,
  partial: Schema.Boolean,
  timestamp: optional(Schema.Number),
})
export type Entry = typeof Entry.Type
export const History = Schema.Struct({
  thread: Thread,
  // Each page is chronological; nextCursor requests an earlier page.
  items: Schema.Array(Entry),
  nextCursor: optional(Schema.String),
})
export type History = typeof History.Type

export interface QueuedInput extends Schema.Schema.Type<typeof QueuedInput> {}
export const QueuedInput = Schema.Struct({ nativeID: ID, inputID: ID, text: Schema.String, partial: Schema.Boolean })
export interface Turn extends Schema.Schema.Type<typeof Turn> {}
export const Turn = Schema.Struct({
  id: ID,
  state: Schema.Literals(["running", "completed", "interrupted", "failed"]),
})
// Observations, not an atomic snapshot or an admission receipt. The latest turn can already be finished.
// Queue pages contain only pending inputs, in native order; nextCursor means the page is incomplete.
export interface Execution extends Schema.Schema.Type<typeof Execution> {}
export const Execution = Schema.Struct({
  thread: Thread,
  turn: optional(Turn),
  queue: Schema.Array(QueuedInput),
  nextCursor: optional(Schema.String),
})
// Invalidation only. Consumers re-read the relevant visible data; this is not a replayable execution log.
export interface Activity extends Schema.Schema.Type<typeof Activity> {}
export const Activity = Schema.Struct({ ref: Ref, change: Schema.Literals(["execution", "history", "both"]) })

// Display projections only: credentials, OAuth tokens and native configuration never cross this surface.
export const Account = Schema.Struct({
  state: Schema.Literals(["signed-in", "signed-out", "not-required"]),
  label: optional(Schema.String),
  plan: optional(Schema.String),
})
export type Account = typeof Account.Type
export const Status = Schema.Struct({ authentication: Schema.NullOr(Account) })
export type Status = typeof Status.Type
export const BrowserLogin = Schema.Struct({
  id: ID,
  url: Schema.String.check(
    Schema.makeFilter((value) => {
      try {
        const url = new URL(value)
        return url.protocol === "https:" && !url.username && !url.password
      } catch {
        return false
      }
    }),
  ),
})
export type BrowserLogin = typeof BrowserLogin.Type
export const AuthenticationEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("updated") }),
  Schema.Struct({ type: Schema.Literal("completed"), loginID: ID, success: Schema.Boolean }),
])
export type AuthenticationEvent = typeof AuthenticationEvent.Type

const errors = {
  unavailable: Schema.toStandardSchemaV1(Schema.Undefined),
  conflict: Schema.toStandardSchemaV1(Schema.Undefined),
  failed: Schema.toStandardSchemaV1(Schema.Undefined),
}
// Uses the existing native RPC transport; does not add a second server or agent loop.
export const Api = Rpc.define({
  id: "experimental.conversation",
  methods: {
    list: {
      input: Schema.toStandardSchemaV1(Schema.Struct({})),
      output: Schema.toStandardSchemaV1(Schema.Array(Descriptor)),
    },
    status: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ backendID: ID })),
      output: Schema.toStandardSchemaV1(Status),
      errors,
    },
    threads: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ backendID: ID, ...Page })),
      output: Schema.toStandardSchemaV1(Threads),
      errors,
    },
    history: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ ref: Ref, ...Page })),
      output: Schema.toStandardSchemaV1(History),
      errors,
    },
    execution: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ ref: Ref, ...Page })),
      output: Schema.toStandardSchemaV1(Execution),
      errors,
    },
    login: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ backendID: ID })),
      output: Schema.toStandardSchemaV1(BrowserLogin),
      errors,
    },
    cancelLogin: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ backendID: ID, loginID: ID })),
      output: Schema.toStandardSchemaV1(Schema.Literals(["canceled", "not-found"])),
      errors,
    },
    create: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ backendID: ID })),
      output: Schema.toStandardSchemaV1(Schema.Json),
      errors,
    },
    query: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ backendID: ID, query: Query })),
      output: Schema.toStandardSchemaV1(Schema.Json),
      errors,
    },
    control: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ backendID: ID, control: Control })),
      output: Schema.toStandardSchemaV1(ControlResult),
      errors,
    },
    send: { input: Schema.toStandardSchemaV1(Input), output: Schema.toStandardSchemaV1(Admission), errors },
  },
  events: {
    activity: { schema: Schema.toStandardSchemaV1(Activity) },
    changed: { schema: Schema.toStandardSchemaV1(Schema.Struct({})) },
    authentication: { schema: Schema.toStandardSchemaV1(Schema.Struct({ backendID: ID, event: AuthenticationEvent })) },
    notification: { schema: Schema.toStandardSchemaV1(Schema.Struct({ backendID: ID, notification: Schema.Json })) },
  },
})
