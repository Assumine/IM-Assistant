export * as SessionOutput from "./output.js"

import { and, asc, desc, eq, gt, gte, sql } from "drizzle-orm"
import { Effect } from "effect"
import { SessionInputOutput } from "@opencode/schema/session-input-output"
import { Database } from "../database/database.js"
import { SessionInput } from "./input.js"
import { SessionHistory } from "./history.js"
import { SessionMessage } from "./message.js"
import { SessionSchema } from "./schema.js"
import { SessionMessageTable } from "./sql.js"

/** Read the original projection, not model context or a second output history. Legacy ownership is never guessed. */
export const read = Effect.fn("SessionOutput.read")(function* (
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
  inputID: SessionMessage.ID,
) {
  const position = yield* SessionInput.inspect(db, sessionID, inputID)
  if (!position.rootID || (position.status !== "open" && position.status !== "closed"))
    return SessionInputOutput.Info.make(position)
  const root = yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.id, position.rootID)))
    .get()
    .pipe(Effect.orDie)
  if (!root) return SessionInputOutput.Info.make({ sessionID, inputID, status: "unknown" })
  const owned = and(
    eq(SessionMessageTable.session_id, sessionID),
    eq(SessionMessageTable.type, "assistant"),
    gte(SessionMessageTable.seq, root.seq),
    sql`json_extract(${SessionMessageTable.data}, '$.inputRootID') = ${position.rootID}`,
  )
  const reply = (message: SessionMessage.Info): SessionInputOutput.Reply | undefined =>
    message.type !== "assistant"
      ? undefined
      : {
          messageID: message.id,
          text:
            message.time.streamed || (message.time.completed && message.finish)
              ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n\n")
              : "",
          settled: !!(message.time.streamed || (message.time.completed && message.finish)),
        }
  // Page only this input's steps. Parts/blob hydration stays in the original history reader.
  let first: SessionInputOutput.Reply | undefined,
    cursor = root.seq - 1
  while (!first) {
    const rows = yield* db
      .select()
      .from(SessionMessageTable)
      .where(and(owned, gt(SessionMessageTable.seq, cursor)))
      .orderBy(asc(SessionMessageTable.seq))
      .limit(64)
      .all()
      .pipe(Effect.orDie)
    const messages = yield* SessionHistory.decodeMessageRows(db, rows).pipe(Effect.orDie)
    first = messages.map(reply).find((value) => value?.settled && value.text.trim())
    if (rows.length < 64) break
    cursor = rows[rows.length - 1]!.seq
  }
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(owned)
    .orderBy(desc(SessionMessageTable.seq))
    .limit(1)
    .all()
    .pipe(Effect.orDie)
  const [last] = (yield* SessionHistory.decodeMessageRows(db, rows).pipe(Effect.orDie)).map(reply)
  return SessionInputOutput.Info.make({ ...position, ...(first ? { first } : {}), ...(last ? { last } : {}) })
})
