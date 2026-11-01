import { Session } from "@opencode/core/session"
import { Database } from "@opencode/core/database/database"
import { SessionOutput } from "@opencode/core/session/output"
import type { SessionID } from "@opencode/schema/session-id"
import type { SessionMessage } from "@opencode/schema/session-message"
import { Effect } from "effect"
import { missingSession } from "./session-error"

export const makeSessionOutput = Effect.gen(function* () {
  const session = yield* Session.Service
  const { db } = yield* Database.Service
  return (input: { sessionID: SessionID; inputID: SessionMessage.ID }) =>
    session.get(input.sessionID).pipe(
      Effect.andThen(() => SessionOutput.read(db, input.sessionID, input.inputID)),
      Effect.catchTag("Session.NotFoundError", missingSession),
    )
})
