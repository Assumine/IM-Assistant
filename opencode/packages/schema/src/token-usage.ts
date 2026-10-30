export * as TokenUsage from "./token-usage.js"

import { Schema } from "effect"

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  reasoning: Schema.Finite,
  cache: Schema.Struct({
    read: Schema.Finite,
    write: Schema.Finite,
  }),
  // Optional for older transcripts. Absence means unknown, never an inferred reported zero.
  provenance: Schema.optional(Schema.Struct({
    input: Schema.Boolean,
    output: Schema.Boolean,
    reasoning: Schema.Boolean,
    cacheRead: Schema.Boolean,
    cacheWrite: Schema.Boolean,
    cost: Schema.optional(Schema.Literals(["reported", "catalog", "unavailable", "mixed"])),
  })),
}).annotate({ identifier: "TokenUsage.Info" })

export function total(tokens: Pick<Info, "input" | "output" | "reasoning" | "cache">) {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}
