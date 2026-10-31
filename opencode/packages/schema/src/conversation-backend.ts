export * as ConversationBackend from "./conversation-backend.js"

import { Schema } from "effect"
import { Rpc } from "./rpc.js"

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
export const Page = { cursor: Schema.optional(Schema.String), limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))) }
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
export const Descriptor = Schema.Struct({ id: ID, label: Schema.String })
export type Descriptor = typeof Descriptor.Type

const errors = { unavailable: Schema.Undefined, conflict: Schema.Undefined, failed: Schema.Undefined }
// Uses the existing native RPC transport; does not add a second server or agent loop.
export const Api = Rpc.define({
  id: "experimental.conversation",
  methods: {
    list: { input: Schema.Struct({}), output: Schema.Array(Descriptor) },
    create: { input: Schema.Struct({ backendID: ID }), output: Schema.Json, errors },
    query: { input: Schema.Struct({ backendID: ID, query: Query }), output: Schema.Json, errors },
    control: { input: Schema.Struct({ backendID: ID, control: Control }), output: Schema.Json, errors },
    send: { input: Input, output: Admission, errors },
  },
  events: { notification: { schema: Schema.Struct({ backendID: ID, notification: Schema.Json }) } },
})
