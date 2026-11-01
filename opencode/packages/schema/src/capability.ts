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
})
export type Info = typeof Info.Type

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
    notifications: {
      input: Schema.toStandardSchemaV1(NoticeQuery),
      output: Schema.toStandardSchemaV1(NoticePage),
      errors,
    },
    markRead: { input: Schema.toStandardSchemaV1(NoticeRef), output: Schema.toStandardSchemaV1(Notice), errors },
  },
  events: { changed: { schema: Schema.toStandardSchemaV1(Schema.Struct({})) } },
})
