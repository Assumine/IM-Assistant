export * as CapabilityNotifications from "./capability-notifications.js"

import { and, asc, desc, eq, exists, gt, gte, lt, or, sql } from "drizzle-orm"
import { alias } from "drizzle-orm/sqlite-core"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { Capability } from "@opencode/schema/capability"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Database } from "./database/database.js"
import { KV } from "./kv.js"
import { KVTable } from "./kv/sql.js"

const prefix = "capability:notice:"
const Stored = Schema.Struct({
  ...Capability.NoticeRef.fields,
  ...Capability.NoticeInput.fields,
  createdAt: Schema.Int,
})
const Marker = Schema.Struct({ at: Schema.Int })
const source = (ref: Capability.NoticeRef) => `${ref.moduleID}:${ref.id}`

export interface Interface {
  readonly publish: (moduleID: string, input: Capability.NoticeInput) => Effect.Effect<boolean, Error>
  readonly resolve: (ref: Capability.NoticeRef) => Effect.Effect<boolean, Error>
  readonly read: (
    ref: Capability.NoticeRef,
  ) => Effect.Effect<{ readonly notice: Capability.Notice; readonly changed: boolean }, Error>
  readonly list: (input: Capability.NoticeQuery) => Effect.Effect<Capability.NoticePage, Error>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/CapabilityNotifications") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const kv = yield* KV.Service
    const db = (yield* Database.Service).db
    const readTable = alias(KVTable, "capability_read")
    const resolvedTable = alias(KVTable, "capability_resolved")
    const read = exists(
      db
        .select({ key: readTable.key })
        .from(readTable)
        .where(eq(readTable.key, sql`'capability:read:' || substr(${KVTable.key}, ${prefix.length + 1})`)),
    )
    const resolved = exists(
      db
        .select({ key: resolvedTable.key })
        .from(resolvedTable)
        .where(eq(resolvedTable.key, sql`'capability:resolved:' || substr(${KVTable.key}, ${prefix.length + 1})`)),
    )
    const own = and(gte(KVTable.key, prefix), lt(KVTable.key, "capability:notice;"))
    const created = sql<number>`json_extract(${KVTable.value}, '$.createdAt')`
    const action = sql`json_extract(${KVTable.value}, '$.requiresAction') = 1 and not ${resolved}`
    const known = Effect.fn("CapabilityNotifications.known")(function* (ref: Capability.NoticeRef) {
      const value = yield* kv.get(prefix + source(ref))
      if (value === undefined) return yield* Effect.fail(new Error("Notification is unavailable"))
      const notice = yield* Schema.decodeUnknownEffect(Stored)(value).pipe(Effect.orDie)
      if (notice.moduleID !== ref.moduleID || notice.id !== ref.id)
        return yield* Effect.fail(new Error("Notification source is invalid"))
      return notice
    })
    const view = Effect.fn("CapabilityNotifications.view")(function* (notice: typeof Stored.Type) {
      const read = yield* kv.get("capability:read:" + source(notice))
      const resolved = yield* kv.get("capability:resolved:" + source(notice))
      return {
        ...notice,
        ...(read === undefined ? {} : { readAt: Schema.decodeUnknownSync(Marker)(read).at }),
        ...(resolved === undefined ? {} : { resolvedAt: Schema.decodeUnknownSync(Marker)(resolved).at }),
      }
    })
    return Service.of({
      publish: Effect.fn("CapabilityNotifications.publish")(function* (
        moduleID: string,
        input: Capability.NoticeInput,
      ) {
        const payload = yield* Schema.decodeUnknownEffect(Capability.NoticeInput)(input).pipe(Effect.orDie)
        const value = { moduleID, ...payload, createdAt: yield* Clock.currentTimeMillis }
        const inserted = yield* kv.insert(prefix + source(value), value)
        if (inserted) return true
        const original = yield* known(value)
        if (
          original.title !== payload.title ||
          original.message !== payload.message ||
          original.severity !== payload.severity ||
          original.requiresAction !== payload.requiresAction
        )
          return yield* Effect.fail(new Error("Notification ID already has different content"))
        return false
      }),
      resolve: Effect.fn("CapabilityNotifications.resolve")(function* (ref: Capability.NoticeRef) {
        yield* known(ref)
        return yield* kv.insert("capability:resolved:" + source(ref), { at: yield* Clock.currentTimeMillis })
      }),
      read: Effect.fn("CapabilityNotifications.read")(function* (ref: Capability.NoticeRef) {
        const notice = yield* known(ref)
        const changed = yield* kv.insert("capability:read:" + source(ref), { at: yield* Clock.currentTimeMillis })
        return { notice: yield* view(notice), changed }
      }),
      list: Effect.fn("CapabilityNotifications.list")(function* (input: Capability.NoticeQuery) {
        const limit = input.limit ?? 50
        const cursor = input.cursor
        const rows = yield* db
          .select({ key: KVTable.key, value: KVTable.value })
          .from(KVTable)
          .where(
            and(
              own,
              cursor
                ? or(
                    lt(created, cursor.createdAt),
                    and(eq(created, cursor.createdAt), gt(KVTable.key, prefix + source(cursor))),
                  )
                : undefined,
              input.filter === "unread" ? sql`not ${read}` : input.filter === "attention" ? action : undefined,
            ),
          )
          .orderBy(desc(created), asc(KVTable.key))
          .limit(limit + 1)
          .all()
          .pipe(Effect.orDie)
        const notices = yield* Effect.forEach(rows.slice(0, limit), (row) =>
          Effect.gen(function* () {
            const notice = yield* Schema.decodeUnknownEffect(Stored)(row.value).pipe(Effect.orDie)
            if (row.key !== prefix + source(notice))
              return yield* Effect.fail(new Error("Notification source is invalid"))
            return yield* view(notice)
          }),
        )
        const counts = yield* db
          .select({
            unread: sql<number>`coalesce(sum(case when ${read} then 0 else 1 end), 0)`.mapWith(Number),
            attention: sql<number>`coalesce(sum(case when ${action} then 1 else 0 end), 0)`.mapWith(Number),
          })
          .from(KVTable)
          .where(own)
          .get()
          .pipe(Effect.orDie)
        const last = notices.at(-1)
        return {
          items: notices,
          counts: counts ?? { unread: 0, attention: 0 },
          ...(rows.length > limit && last
            ? { next: { moduleID: last.moduleID, id: last.id, createdAt: last.createdAt } }
            : {}),
        }
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [KV.node, Database.node] })
