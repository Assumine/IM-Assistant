export * as SessionInputOutput from "./session-input-output.js"

import { Schema } from "effect"
import { InputPosition } from "./session-inbox.js"
import { SessionMessage } from "./session-message.js"
import { optional } from "./schema.js"

/** Public text only. A settled response body does not imply tool settlement or task success. */
export const Reply = Schema.Struct({ messageID: SessionMessage.ID, text: Schema.String, settled: Schema.Boolean })
export type Reply = typeof Reply.Type
export const Info = Schema.Struct({
  ...InputPosition.fields,
  first: Reply.pipe(optional),
  last: Reply.pipe(optional),
}).annotate({ identifier: "Session.InputOutput" })
export type Info = typeof Info.Type
