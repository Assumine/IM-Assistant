import { Schema } from "effect"
import { HttpApiEndpoint, OpenApi } from "effect/http-api"
import { SessionID } from "@opencode/schema/session-id"
import { SessionMessage } from "@opencode/schema/session-message"
import { SessionInputOutput } from "@opencode/schema/session-input-output"
import { SessionNotFoundError } from "../errors.js"

export const SessionOutputEndpoint = HttpApiEndpoint.get(
  "session.input.output",
  "/api/experimental/session/:sessionID/input/:inputID/output",
  {
    params: Schema.Struct({ sessionID: SessionID, inputID: SessionMessage.ID }),
    success: SessionInputOutput.Info,
    error: SessionNotFoundError,
  },
).annotateMerge(
  OpenApi.annotations({
    identifier: "experimental.session.input.output",
    summary: "Read public output for a proven native input boundary",
    description:
      "Read-only first/latest settled assistant text with native input ownership. Never resumes work, returns reasoning/tools or guesses legacy ownership. Closed is a boundary fact, not a success claim. Experimental: may change without compatibility guarantees.",
  }),
)
