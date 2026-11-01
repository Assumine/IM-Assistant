export * as ConversationBackend from "./conversation-backend.js"

import { Schema } from "effect"
import { Rpc } from "./rpc.js"
import { optional } from "./schema.js"

const ID = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/))
export const Ref = Schema.Struct({ backendID: ID, threadID: ID })
export type Ref = typeof Ref.Type
const fields = { ref: Ref, inputID: ID, text: Schema.String.check(Schema.isPattern(/\S/)) }
// Native user input and its exact, observed terminal turn. This is a relationship, not another execution state.
export const ParentInput = Schema.Struct({ inputID: ID, turnID: ID, nativeID: ID })
export type ParentInput = typeof ParentInput.Type
export const Input = Schema.Union([
  Schema.Struct({ ...fields, delivery: Schema.optional(Schema.Literal("queue")), followupOf: optional(ParentInput) }),
  Schema.Struct({ ...fields, delivery: Schema.Literal("steer"), expectedTurnID: ID }),
])
export type Input = typeof Input.Type
export type FollowupInput = Extract<Input, { delivery?: "queue" }> & { followupOf: ParentInput }
export const Receipt = Schema.Struct({ nativeID: ID, kind: Schema.Literals(["queued", "steered", "message"]) })
export type Receipt = typeof Receipt.Type
// A definitive backend refusal, not a timeout or an ambiguous delivery failure. Never contains private error text.
export const Rejection = Schema.Struct({ status: Schema.Literal("rejected"), reason: Schema.Literal("not-accepted") })
export interface Rejection extends Schema.Schema.Type<typeof Rejection> {}
export const Admission = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("accepted"),
    ref: Ref,
    inputID: ID,
    receipt: Receipt,
    followupOf: optional(ParentInput),
  }),
  Schema.Struct({ status: Schema.Literal("uncertain"), ref: Ref, inputID: ID, followupOf: optional(ParentInput) }),
  Schema.Struct({ ...Rejection.fields, ref: Ref, inputID: ID, followupOf: optional(ParentInput) }),
])
export type Admission = typeof Admission.Type
// Fresh native identity observation, independent of cached admission receipts. It is not an active-turn claim.
export const InputPosition = Schema.Union([
  Schema.Struct({ ref: Ref, inputID: ID, status: Schema.Literal("unknown") }),
  Schema.Struct({ ref: Ref, inputID: ID, status: Schema.Literal("queued"), nativeID: ID }),
  Schema.Struct({ ref: Ref, inputID: ID, status: Schema.Literal("delivered"), nativeID: ID, turnID: ID }),
  Schema.Struct({
    ref: Ref,
    inputID: ID,
    status: Schema.Literal("closed"),
    nativeID: ID,
    turnID: ID,
    state: Schema.Literals(["completed", "interrupted", "failed"]),
  }),
])
export type InputPosition = typeof InputPosition.Type
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
  Schema.Struct({
    action: Schema.Literal("answer"),
    threadID: ID,
    questionID: ID,
    answers: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  }),
  Schema.Struct({ action: Schema.Literal("dismiss-question"), threadID: ID, questionID: ID }),
])
export type Control = typeof Control.Type
// An acknowledgement, never a replacement execution snapshot. Missing means a pending input already left the queue.
// Transport/backend failures remain errors with unknown effect; callers must not infer success or automatically retry.
// For human input, resolved confirms native resolution, potentially by another attached client; not whose answer won.
export const ControlResult = Schema.Struct({ status: Schema.Literals(["applied", "not-found", "resolved"]) })
export type ControlResult = typeof ControlResult.Type
export const Descriptor = Schema.Struct({
  id: ID,
  label: Schema.String,
  browse: optional(Schema.Boolean),
  execution: optional(Schema.Boolean),
  create: optional(Schema.Boolean),
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
// A new native conversation, with display metadata only. Creation never admits a prompt or resumes pending work.
export interface Created extends Schema.Schema.Type<typeof Created> {}
export const Created = Schema.Struct({ thread: Thread }).annotate({ identifier: "ConversationBackend.Created" })
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
  // Ephemeral active text, scoped to this live backend connection. It is not another history database.
  content: optional(Schema.Struct({ streamID: ID, items: Schema.Array(Entry) })),
})
export type History = typeof History.Type

export interface QueuedInput extends Schema.Schema.Type<typeof QueuedInput> {}
export const QueuedInput = Schema.Struct({ nativeID: ID, inputID: ID, text: Schema.String, partial: Schema.Boolean })
export interface Turn extends Schema.Schema.Type<typeof Turn> {}
export const Turn = Schema.Struct({
  id: ID,
  state: Schema.Literals(["running", "completed", "interrupted", "failed"]),
})
// Live, non-secret human questions only. IDs expire with the connection/turn; never replay answers after reconnect.
export interface Question extends Schema.Schema.Type<typeof Question> {}
export const Question = Schema.Struct({
  id: ID,
  turnID: ID,
  itemID: ID,
  blocking: Schema.Boolean,
  state: Schema.Literals(["pending", "responding"]),
  prompts: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      header: Schema.String,
      question: Schema.String,
      other: Schema.Boolean,
      options: Schema.Array(Schema.Struct({ label: Schema.String, description: Schema.String })),
    }),
  ),
})
// Observations, not an atomic snapshot or an admission receipt. The latest turn can already be finished.
// Queue pages contain only pending inputs, in native order; nextCursor means the page is incomplete.
export interface Execution extends Schema.Schema.Type<typeof Execution> {}
export const Execution = Schema.Struct({
  thread: Thread,
  turn: optional(Turn),
  queue: Schema.Array(QueuedInput),
  nextCursor: optional(Schema.String),
  questions: optional(Schema.Array(Question)),
})
// Invalidation only. Consumers re-read the relevant visible data; this is not a replayable execution log.
export interface Activity extends Schema.Schema.Type<typeof Activity> {}
export const Activity = Schema.Struct({ ref: Ref, change: Schema.Literals(["execution", "history", "both"]) })
// Native ordered text feed. Offsets count UTF-16 code units, matching JS strings; a new connection has a new stream ID.
export const Content = Schema.Union([
  Schema.Struct({ type: Schema.Literal("snapshot"), ref: Ref, streamID: ID, entry: Entry, done: Schema.Boolean }),
  Schema.Struct({
    type: Schema.Literal("append"),
    ref: Ref,
    streamID: ID,
    turnID: ID,
    itemID: ID,
    offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    text: Schema.String,
  }),
])
export type Content = typeof Content.Type

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
      output: Schema.toStandardSchemaV1(Created),
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
    // Receipt-only observation. Never admits, resumes or replays an input, even if no admission fact exists.
    reconcile: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ ref: Ref, inputID: ID })),
      output: Schema.toStandardSchemaV1(Admission),
      errors,
    },
    input: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ ref: Ref, inputID: ID })),
      output: Schema.toStandardSchemaV1(InputPosition),
      errors,
    },
  },
  events: {
    content: { schema: Schema.toStandardSchemaV1(Content) },
    activity: { schema: Schema.toStandardSchemaV1(Activity) },
    changed: { schema: Schema.toStandardSchemaV1(Schema.Struct({})) },
    authentication: { schema: Schema.toStandardSchemaV1(Schema.Struct({ backendID: ID, event: AuthenticationEvent })) },
    notification: { schema: Schema.toStandardSchemaV1(Schema.Struct({ backendID: ID, notification: Schema.Json })) },
  },
})
