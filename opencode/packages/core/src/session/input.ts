export * as SessionInput from "./input.js"

import { Hash } from "@opencode/util/hash"
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Continuation } from "@opencode/schema/session-inbox"
import { Database } from "../database/database.js"
import { KVTable } from "../kv/sql.js"
import { SessionMessage } from "./message.js"
import { SessionSchema } from "./schema.js"
import { SessionInboxTable, SessionMessageTable } from "./sql.js"
import { SessionBlob } from "./blob.js"

type DB = Database.Interface["db"]
export type Ref = {
  readonly sessionID: SessionSchema.ID
  readonly id: SessionMessage.ID
  readonly expectedInputID: SessionMessage.ID
}
const currentKey = (sessionID: SessionSchema.ID) => `session:input-current:${Hash.sha256(sessionID)}`
const ownerKey = (id: SessionMessage.ID) => `session:input-owner:${Hash.sha256(id)}`
const prefix = (sessionID: SessionSchema.ID) => `session:input-continuation:${Hash.sha256(sessionID)}:`
const key = (sessionID: SessionSchema.ID, id: SessionMessage.ID) => prefix(sessionID) + Hash.sha256(id)
const Owner = Schema.Struct({ sessionID: SessionSchema.ID, rootID: SessionMessage.ID })
const Record = Schema.Struct({
  ...Continuation.fields,
  rootID: SessionMessage.ID,
  requestHash: Schema.String,
  status: Schema.Literals(["pending", "delivered", "cancelled", "expired"]),
})

const read = Effect.fn("SessionInput.read")(function* (db: DB, name: string) {
  return (yield* db
    .select({ value: KVTable.value })
    .from(KVTable)
    .where(eq(KVTable.key, name))
    .get()
    .pipe(Effect.orDie))?.value
})
const write = (db: DB, name: string, value: typeof KVTable.$inferInsert.value) =>
  db
    .insert(KVTable)
    .values({ key: name, value })
    .onConflictDoUpdate({ target: KVTable.key, set: { value } })
    .run()
    .pipe(Effect.orDie)

/** Native derived projection: which delivered user inputs still belong to this input boundary. */
export const current = Effect.fn("SessionInput.current")(function* (db: DB, sessionID: SessionSchema.ID) {
  const value = yield* read(db, currentKey(sessionID))
  return value === undefined ? undefined : yield* Schema.decodeUnknownEffect(Owner)(value).pipe(Effect.orDie)
})
export const belongs = Effect.fn("SessionInput.belongs")(function* (
  db: DB,
  sessionID: SessionSchema.ID,
  expectedInputID: SessionMessage.ID,
) {
  const active = yield* current(db, sessionID)
  if (!active || active.sessionID !== sessionID) return undefined
  const value = yield* read(db, ownerKey(expectedInputID))
  if (value === undefined) return undefined
  const owner = yield* Schema.decodeUnknownEffect(Owner)(value).pipe(Effect.orDie)
  if (owner.sessionID !== sessionID || owner.rootID !== active.rootID) return undefined
  // History can be truncated by a native revert. A retained ownership receipt cannot revive a removed input.
  const rows = yield* db
    .select({ id: SessionMessageTable.id })
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        eq(SessionMessageTable.type, "user"),
        inArray(SessionMessageTable.id, [expectedInputID, active.rootID]),
      ),
    )
    .all()
    .pipe(Effect.orDie)
  return rows.some((row) => row.id === expectedInputID) && rows.some((row) => row.id === active.rootID)
    ? active.rootID
    : undefined
})
export const recorded = Effect.fn("SessionInput.recorded")(function* (
  db: DB,
  sessionID: SessionSchema.ID,
  id: SessionMessage.ID,
) {
  const value = yield* read(db, key(sessionID, id))
  return value === undefined ? undefined : yield* Schema.decodeUnknownEffect(Record)(value).pipe(Effect.orDie)
})
export const receipt = (input: Ref, record?: typeof Record.Type) =>
  Continuation.make({
    sessionID: input.sessionID,
    inboxID: input.id,
    expectedInputID: input.expectedInputID,
    ...(record ? { rootID: record.rootID } : {}),
    status: record?.status ?? "unknown",
  })

/** Called only inside the InboxEnqueued event transaction, with the original Inbox row in that same transaction. */
export const projectAdmitted = Effect.fn("SessionInput.projectAdmitted")(function* (
  db: DB,
  input: Ref & { readonly requestHash: string },
) {
  if (input.id === input.expectedInputID) return false
  const rootID = yield* belongs(db, input.sessionID, input.expectedInputID)
  if (!rootID) return false
  const row = yield* db
    .insert(KVTable)
    .values({
      key: key(input.sessionID, input.id),
      value: {
        sessionID: input.sessionID,
        inboxID: input.id,
        expectedInputID: input.expectedInputID,
        rootID,
        requestHash: input.requestHash,
        status: "pending",
      },
    })
    .onConflictDoNothing()
    .returning({ key: KVTable.key })
    .get()
    .pipe(Effect.orDie)
  return row !== undefined
})

/** Close only the named boundary; a late close can never expire a successor's input. */
export const projectClosed = Effect.fn("SessionInput.projectClosed")(function* (
  db: DB,
  sessionID: SessionSchema.ID,
  rootID: SessionMessage.ID,
) {
  const active = yield* current(db, sessionID)
  if (!active || active.rootID !== rootID) return
  const pending = yield* db
    .select({ key: KVTable.key, value: KVTable.value })
    .from(KVTable)
    .where(
      and(
        gte(KVTable.key, prefix(sessionID)),
        lt(KVTable.key, prefix(sessionID) + "\uffff"),
        sql`json_extract(${KVTable.value}, '$.rootID') = ${rootID}`,
        sql`json_extract(${KVTable.value}, '$.status') = 'pending'`,
      ),
    )
    .all()
    .pipe(Effect.orDie)
  for (const row of pending) {
    const record = yield* Schema.decodeUnknownEffect(Record)(row.value).pipe(Effect.orDie)
    yield* db
      .delete(SessionInboxTable)
      .where(and(eq(SessionInboxTable.session_id, sessionID), eq(SessionInboxTable.id, record.inboxID)))
      .run()
      .pipe(Effect.orDie)
    yield* SessionBlob.releaseMessage(db, sessionID, record.inboxID)
    yield* write(db, row.key, { ...record, status: "expired" })
  }
  yield* db
    .delete(KVTable)
    .where(eq(KVTable.key, currentKey(sessionID)))
    .run()
    .pipe(Effect.orDie)
})
export const projectTerminal = Effect.fn("SessionInput.projectTerminal")(function* (
  db: DB,
  sessionID: SessionSchema.ID,
) {
  const active = yield* current(db, sessionID)
  if (active) yield* projectClosed(db, sessionID, active.rootID)
})

/** Queue deliveries open a fresh boundary; ordinary steers inherit the current one. */
export const projectDelivered = Effect.fn("SessionInput.projectDelivered")(function* (
  db: DB,
  input: {
    readonly sessionID: SessionSchema.ID
    readonly id: SessionMessage.ID
    readonly delivery: "queue" | "steer"
  },
) {
  const active = yield* current(db, input.sessionID)
  const record = yield* recorded(db, input.sessionID, input.id)
  if (record && (record.status !== "pending" || input.delivery !== "steer" || active?.rootID !== record.rootID))
    return false
  const rootID = record?.rootID ?? (input.delivery === "steer" ? active?.rootID : undefined) ?? input.id
  if (active && active.rootID !== rootID) yield* projectClosed(db, input.sessionID, active.rootID)
  const owner = { sessionID: input.sessionID, rootID }
  yield* write(db, currentKey(input.sessionID), owner)
  yield* write(db, ownerKey(input.id), owner)
  if (record) yield* write(db, key(input.sessionID, input.id), { ...record, status: "delivered" })
  return true
})
export const projectCancelled = Effect.fn("SessionInput.projectCancelled")(function* (
  db: DB,
  sessionID: SessionSchema.ID,
  id: SessionMessage.ID,
) {
  const record = yield* recorded(db, sessionID, id)
  if (record?.status === "pending") yield* write(db, key(sessionID, id), { ...record, status: "cancelled" })
})
