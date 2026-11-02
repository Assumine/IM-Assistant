import { Effect } from "effect"
import { CodeMode, Tool } from "../../../opencode/packages/codemode/src/index"
import { json, outcome, stable, validator, type CollectionEvidence, type Draft, type Primitive } from "./contracts"
import type { Outcome, ResearchPath } from "./types"

/** Confined business program: only the explicitly named collector primitives, no host JS or filesystem. */
export function compilePath(draft: Draft, available: readonly Primitive[], observed?: (evidence: CollectionEvidence) => void): ResearchPath {
  const input = validator(draft.inputSchema), output = validator(draft.outputSchema)
  if (new Set(draft.tools).size !== draft.tools.length || draft.tools.some((id) => !available.some((item) => item.id === id)))
    throw new Error("Unknown or duplicate collector primitive")
  return {
    id: draft.id, revision: draft.revision, category: draft.category, action: draft.action, title: draft.title,
    accepts: input, validates: output,
    async run(parameters, { signal }) {
      const memo = new Map<string, Promise<Outcome>>()
      let barrier: Outcome | undefined
      const tools = Object.fromEntries(draft.tools.map((id) => {
        const primitive = available.find((item) => item.id === id)!
        const accepts = validator(primitive.inputSchema), validates = validator(primitive.outputSchema)
        return [id, Tool.make({ description: primitive.description, input: primitive.inputSchema as Tool.JsonSchema, output: { type: "object" },
          execute: (raw) => Effect.tryPromise(async () => {
            const args = json(raw)
            if (signal.aborted) throw new Error("Research cancelled")
            if (barrier) return barrier
            if (!accepts(args)) throw new Error("Invalid collector input")
            const key = id + ":" + stable(args)
            let value = memo.get(key)
            if (!value) {
              value = primitive.execute(structuredClone(args), { signal }).then((raw) => {
                const response = outcome(raw)
                if (response.status === "success" && !validates(response.value)) throw new Error("Invalid collector output")
                observed?.({ primitiveID: id, input: structuredClone(args), outcome: structuredClone(response) })
                if (response.status === "blocked" || response.status === "uncertain") barrier = response
                return response
              }).catch(() => { barrier = { status: "uncertain", reason: "collector-result-unknown" }; return barrier })
              memo.set(key, value)
            }
            return value
          }),
        })]
      }))
      try {
        const response = await Effect.runPromise(CodeMode.execute({ code: draft.program, bindings: { input: parameters }, tools,
          limits: { timeoutMs: 60000, maxOutputBytes: 512000 } }), { signal })
        if (barrier) return barrier
        if (!response.ok) return { status: response.toolCalls.length ? "uncertain" : "failure", reason: "program-" + response.error.kind + ": " + response.error.message }
        const value = outcome(response.value)
        if (value.status === "success" && !output(value.value)) return { status: "failure", reason: "invalid-path-output" }
        return value
      } catch { return barrier ?? { status: "uncertain", reason: signal.aborted ? "research-cancelled" : "collector-result-unknown" } }
    },
  }
}
