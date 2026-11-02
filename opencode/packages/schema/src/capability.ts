export * as Capability from "./capability.js"

import { Schema } from "effect"
import { Rpc } from "./rpc.js"
import { optional } from "./schema.js"

/** Installed application capabilities, not dependency packages or a second conversation backend. */
export const ID = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/))
const LocalID = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/))
const Time = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Label = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160))

export const Health = Schema.Struct({
  phase: Schema.Literals(["starting", "ready", "degraded", "unavailable"]),
  message: optional(Schema.String.check(Schema.isMaxLength(1000))),
})
export type Health = typeof Health.Type

export const Info = Schema.Struct({
  id: ID,
  title: Label,
  state: Schema.Literals(["loading", "active", "disabled", "failed", "stopped"]),
  health: optional(Health),
  metrics: Schema.Boolean,
  settings: optional(Schema.Boolean),
  view: optional(Schema.Boolean),
})
export type Info = typeof Info.Type

/** Declarative module-owned settings. Secrets must remain outside this document. */
export const Settings = Schema.Struct({
  revision: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  text: Schema.String.check(Schema.isMaxLength(524288)),
  description: optional(Schema.String.check(Schema.isMaxLength(1000))),
  appliesTo: Schema.Literal("next-service-start"),
}).annotate({ identifier: "Capability.Settings" })
export interface Settings extends Schema.Schema.Type<typeof Settings> {}

export const Metric = Schema.Struct({
  id: LocalID,
  label: Label,
  value: Schema.Finite,
  unit: Schema.Literals(["percent", "bytes", "milliseconds", "count"]),
})
export type Metric = typeof Metric.Type
export const Metrics = Schema.Struct({
  id: ID,
  status: Schema.Literals(["ready", "unsupported", "unavailable", "failed"]),
  collectedAt: optional(Time),
  items: Schema.Array(Metric).check(Schema.isMaxLength(64)),
})
export type Metrics = typeof Metrics.Type

/** Bounded module text and declarative controls; never HTML, callbacks or native task mutations. */
/** Declarative module controls. Execution stays in the trusted module, never in document content. */
export const ViewAction = Schema.Struct({
  id: LocalID,
  label: Label,
  target: optional(LocalID),
  fields: optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String.check(Schema.isPattern(/^(?!constructor$|prototype$)[A-Za-z][A-Za-z0-9_]{0,39}$/)),
        label: Label,
        placeholder: optional(Schema.String.check(Schema.isMaxLength(300))),
        required: optional(Schema.Boolean),
      }),
    ).check(Schema.isMaxLength(8)),
  ),
})
export type ViewAction = typeof ViewAction.Type
export const Invocation = Schema.Struct({
  id: ID,
  action: LocalID,
  requestID: LocalID,
  target: optional(LocalID),
  values: Schema.String.check(Schema.isMaxLength(65536)),
  locale: optional(Schema.String.check(Schema.isMaxLength(40))),
})
export type Invocation = typeof Invocation.Type
export const ActionResult = Schema.Struct({
  state: Schema.Literals(["applied", "rejected", "uncertain"]),
  message: Schema.String.check(Schema.isMaxLength(2000)),
})
export type ActionResult = typeof ActionResult.Type

export interface ViewItem extends Schema.Schema.Type<typeof ViewItem> {}
export const ViewItem = Schema.Struct({
  id: LocalID,
  title: Label,
  subtitle: optional(Schema.String.check(Schema.isMaxLength(300))),
  state: Schema.Literals(["running", "waiting", "success", "attention", "error", "unknown"]),
  status: Label,
  fields: Schema.Array(Schema.Struct({ label: Label, value: Schema.String.check(Schema.isMaxLength(4000)) })).check(
    Schema.isMaxLength(16),
  ),
  technical: optional(Schema.String.check(Schema.isMaxLength(32000))),
  actions: optional(Schema.Array(ViewAction).check(Schema.isMaxLength(6))),
  progress: optional(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
}).annotate({ identifier: "Capability.ViewItem" })

export interface View extends Schema.Schema.Type<typeof View> {}
export const View = Schema.Struct({
  title: Label,
  description: optional(Schema.String.check(Schema.isMaxLength(1000))),
  empty: optional(Schema.String.check(Schema.isMaxLength(1000))),
  items: Schema.Array(ViewItem).check(Schema.isMaxLength(30)),
  actions: optional(Schema.Array(ViewAction).check(Schema.isMaxLength(8))),
  refreshAfterMs: optional(Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 60000 }))),
}).annotate({ identifier: "Capability.View" })

export interface ViewResult extends Schema.Schema.Type<typeof ViewResult> {}
export const ViewResult = Schema.Struct({
  id: ID,
  status: Schema.Literals(["ready", "unsupported", "unavailable", "failed"]),
  document: optional(View),
}).annotate({ identifier: "Capability.ViewResult" })

export const NoticeRef = Schema.Struct({ moduleID: ID, id: LocalID })
export type NoticeRef = typeof NoticeRef.Type
export const NoticeInput = Schema.Struct({
  id: LocalID,
  title: Label,
  message: optional(Schema.String.check(Schema.isMaxLength(16000))),
  severity: Schema.Literals(["info", "warning", "error"]),
  requiresAction: Schema.Boolean,
})
export type NoticeInput = typeof NoticeInput.Type
export const Notice = Schema.Struct({
  ...NoticeRef.fields,
  ...NoticeInput.fields,
  createdAt: Time,
  readAt: optional(Time),
  resolvedAt: optional(Time),
})
export type Notice = typeof Notice.Type
export const Counts = Schema.Struct({ unread: Schema.Int, attention: Schema.Int })
export type Counts = typeof Counts.Type
export const Cursor = Schema.Struct({ ...NoticeRef.fields, createdAt: Time })
export const NoticeQuery = Schema.Struct({
  filter: optional(Schema.Literals(["all", "unread", "attention"])),
  cursor: optional(Cursor),
  limit: optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
})
export type NoticeQuery = typeof NoticeQuery.Type
export const NoticePage = Schema.Struct({
  items: Schema.Array(Notice),
  next: optional(Cursor),
  counts: Counts,
})
export type NoticePage = typeof NoticePage.Type

const errors = {
  unavailable: Schema.toStandardSchemaV1(Schema.Undefined),
  failed: Schema.toStandardSchemaV1(Schema.Undefined),
  conflict: Schema.toStandardSchemaV1(Schema.Undefined),
}

/** Experimental application metadata over the original RPC transport; cannot submit or resume AI work. */
export const Api = Rpc.define({
  id: "experimental.capability",
  methods: {
    list: {
      input: Schema.toStandardSchemaV1(Schema.Struct({})),
      output: Schema.toStandardSchemaV1(Schema.Array(Info)),
    },
    stop: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ id: ID })),
      output: Schema.toStandardSchemaV1(Info),
      errors,
    },
    metrics: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ id: ID })),
      output: Schema.toStandardSchemaV1(Metrics),
      errors,
    },
    view: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({ id: ID, locale: optional(Schema.String.check(Schema.isMaxLength(40))) }),
      ),
      output: Schema.toStandardSchemaV1(ViewResult),
      errors,
    },
    invoke: {
      input: Schema.toStandardSchemaV1(Invocation),
      output: Schema.toStandardSchemaV1(ActionResult),
      errors,
    },
    settings: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ id: ID })),
      output: Schema.toStandardSchemaV1(Settings),
      errors,
    },
    configure: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({ id: ID, revision: Settings.fields.revision, text: Settings.fields.text }),
      ),
      output: Schema.toStandardSchemaV1(Settings),
      errors,
    },
    notifications: {
      input: Schema.toStandardSchemaV1(NoticeQuery),
      output: Schema.toStandardSchemaV1(NoticePage),
      errors,
    },
    markRead: { input: Schema.toStandardSchemaV1(NoticeRef), output: Schema.toStandardSchemaV1(Notice), errors },
  },
  events: {
    changed: { schema: Schema.toStandardSchemaV1(Schema.Struct({})) },
    viewChanged: { schema: Schema.toStandardSchemaV1(Schema.Struct({ id: ID })) },
  },
})
