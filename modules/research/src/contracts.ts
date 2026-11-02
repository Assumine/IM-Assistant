import { JsonSchema, Schema, SchemaRepresentation } from "effect"
import type { Data, Outcome } from "./types"

export interface Identity { backendID: string; threadID: string }
/** Host-bound external input provenance; never accepted in model tool arguments. */
export interface Caller extends Identity { inputID?: string; signal?: AbortSignal }
export interface Role { version: number; holder: Identity | null }
export interface Primitive {
  id: string
  description: string
  inputSchema: Record<string, Data>
  outputSchema: Record<string, Data>
  readOnly?: boolean
  execute: (input: Data, context: { signal: AbortSignal }) => Promise<Outcome>
}
export interface Draft {
  id: string
  revision: string
  category: string
  action: string
  title: string
  program: string
  tools: string[]
  inputSchema: Record<string, Data>
  outputSchema: Record<string, Data>
  validForMs?: number
}
export interface Candidate {
  id: string
  pathID: string
  at: string
  direction: string
  evidence: string
  expectedInput: string
  expectedOutput: string
}
export interface CollectionEvidence { primitiveID: string; input: Data; outcome: Outcome }

export function json(value: unknown): Data { return Schema.decodeUnknownSync(Schema.Json)(value) }
export function stable(value: Data): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]"
  if (value !== null && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => JSON.stringify(key) + ":" + stable(item)).join(",") + "}"
  return JSON.stringify(value)
}
export function same(a: Identity | null, b: Identity): boolean { return a?.backendID === b.backendID && a.threadID === b.threadID }

export function validator(schema: Record<string, Data>) {
  const representation = JsonSchema.fromSchemaDraft2020_12(schema)
  const codec = Schema.make<Schema.Codec<unknown>>(SchemaRepresentation.fromJsonSchemaDocument(representation).ast)
  return (value: Data) => {
    try { Schema.decodeUnknownSync(codec)(value, { onExcessProperty: schema.additionalProperties === false ? "error" : "ignore" }); return true }
    catch { return false }
  }
}

export const outcomeSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal("success"), value: Schema.Json }),
  Schema.Struct({ status: Schema.Literals(["failure", "blocked", "uncertain"]), reason: Schema.String }),
])
export function outcome(value: unknown): Outcome { return Schema.decodeUnknownSync(outcomeSchema)(value) }

export const draftSchema = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)), revision: Schema.String.check(Schema.isMinLength(1)),
  category: Schema.String.check(Schema.isMinLength(1)), action: Schema.String.check(Schema.isMinLength(1)),
  title: Schema.String.check(Schema.isMinLength(1)), program: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200000)),
  tools: Schema.mutable(Schema.Array(Schema.String)),
  inputSchema: Schema.Record(Schema.String, Schema.Json), outputSchema: Schema.Record(Schema.String, Schema.Json),
  validForMs: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0), Schema.isFinite())),
})
export function draft(value: unknown): Draft { return Schema.decodeUnknownSync(draftSchema)(value) }

export const candidateSchema = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)), pathID: Schema.String.check(Schema.isMinLength(1)),
  at: Schema.String.check(Schema.isMinLength(1)), direction: Schema.String.check(Schema.isMinLength(1)),
  evidence: Schema.String.check(Schema.isMinLength(1)), expectedInput: Schema.String, expectedOutput: Schema.String,
})
export function candidate(value: unknown): Candidate { return Schema.decodeUnknownSync(candidateSchema)(value) }

export async function digest(value: Data): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value)))
  return [...new Uint8Array(bytes)].map((item) => item.toString(16).padStart(2, "0")).join("")
}

export function validIdentity(value: Identity) {
  if (![value.backendID, value.threadID].every((part) => /^[A-Za-z0-9_-]{1,128}$/.test(part))) throw new Error("Invalid conversation identity")
}
