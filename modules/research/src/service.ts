import type { Info } from "../../../opencode/packages/plugin/src/promise/tool"
import { assistanceInstructions, createOwner } from "./owner"
import { json, validator, type Caller, type Identity } from "./contracts"
import type { Data, ResearchInput } from "./types"

export type Owner = ReturnType<typeof createOwner>
const text = { type: "string", minLength: 1 }
const data = {}
const object = (properties: Record<string, Data>, required = Object.keys(properties)) => ({ type: "object" as const, properties, required, additionalProperties: false })

/** One business contract shared by native model tools and MCP. Caller identity is host-supplied, never an argument. */
export function researchService(owner: Owner, validateActor: (actor: Identity) => Promise<void> = async () => {},
  resolveInput?: (actor: Caller, messageID?: string) => Promise<ResearchInput>) {
  const definitions = [
    { name: "identity", description: "Read the transferable research-assistance identity, responsibilities and current version.", input: object({}) },
    { name: "adopt", description: "Take the research-assistance role in this conversation using its observed version; knowledge stays in the module.", input: object({ expectedVersion: { type: "integer", minimum: 0 } }) },
    { name: "paths", description: "Read shared paths, authorized collector schemas, candidate directions and assistance requests, or one draft revision.", input: object({ pathID: text, revision: text }, []) },
    { name: "save", description: "Save an immutable research collection function draft. Only the role holder can edit; use declared collector primitives, not host code.", input: object({ definition: { type: "object" } }) },
    { name: "candidate", description: "Record an actually discovered alternative direction and evidence. This is a hint, never executable until implemented and tested.", input: object({ id: text, pathID: text, at: text, direction: text, evidence: text, expectedInput: text, expectedOutput: text }) },
    { name: "probe", description: "Role holder explores one authorized collector method with its declared parameters. Stop on login/captcha or unknown results.", input: object({ primitiveID: text, input: data }) },
    { name: "test", description: "Role holder runs one immutable draft with real collector I/O and records the result; tests do not change production route scores.", input: object({ testID: text, pathID: text, revision: text, input: data }) },
    { name: "publish", description: "Publish this exact immutable revision only after a successful recorded test. Failed or untested candidates cannot be selected.", input: object({ pathID: text, revision: text, testID: text }) },
    { name: "run", description: "Run a published function within the host-proven native input. roundID labels this collection call; changing it never resets input-wide scores. Pass checkpoint IDs in after when using upstream outputs.", input: object({ roundID: text, category: text, action: text, input: data, after: { type: "array", items: text } }, ["roundID", "category", "action", "input"]) },
    { name: "progress", description: "Read this native input's branch scores, valid checkpoints, collection results and recovery state. Does not execute or resume anything.", input: object({}) },
    { name: "help", description: "Ask the current research-assistance identity to investigate a gap. Admission uses its native conversation queue, not another research queue.", input: object({ requestID: text, goal: text, issue: text, evidence: data }) },
  ]
  const schemas = new Map(definitions.map((item) => [item.name, validator(item.input)]))
  const pending = new Set<Promise<Data>>()
  let closed = false
  async function execute(caller: Caller, name: string, raw: unknown, signal?: AbortSignal, messageID?: string): Promise<Data> {
    try {
      const actor = { backendID: caller.backendID, threadID: caller.threadID }
      const input = json(raw)
      if (!schemas.get(name)?.(input)) throw new Error("Invalid research tool input")
      const args = input as Record<string, Data>
      if (name === "identity") return json({ role: await owner.role(), instructions: assistanceInstructions })
      if (name === "adopt") { await validateActor(actor); return json({ ...await owner.adopt(actor, args.expectedVersion as number), instructions: assistanceInstructions }) }
      if (name === "paths") return json(args.pathID && args.revision ? await owner.getDraft(args.pathID as string, args.revision as string) : await owner.catalog())
      if (name === "save") return json(await owner.save(actor, args.definition))
      if (name === "candidate") return json(await owner.candidate(actor, input))
      if (name === "probe") return json(await owner.probe(actor, args.primitiveID as string, args.input!, signal))
      if (name === "test") return json(await owner.test(actor, { id: args.testID as string, pathID: args.pathID as string, revision: args.revision as string, input: args.input! }, signal))
      if (name === "publish") return json(await owner.publish(actor, args.pathID as string, args.revision as string, args.testID as string))
      if (name === "run" || name === "progress") {
        if (!resolveInput) throw new Error("Research execution requires host-proven native input provenance")
        const input = await resolveInput(caller, messageID)
        if (name === "progress") return json(await owner.progress(input))
        const response = await owner.collect(input, { roundID: args.roundID as string,
          category: args.category as string, action: args.action as string, input: args.input!,
          ...(args.after === undefined ? {} : { after: args.after as string[] }),
          signal: AbortSignal.any([...(signal ? [signal] : []), ...(caller.signal ? [caller.signal] : [])]),
        })
        if (["blocked", "uncertain", "exhausted", "no-path"].includes(response.status) && response.reason !== "collection-already-running") {
          try { if (await owner.inputOpen(input)) response.assistance = json(await owner.requestHelp(actor, { id: "native:" + input.backendID + ":" + input.threadID + ":" + input.inputID,
            goal: "Complete the research input using published collection functions", issue: response.reason ?? response.status,
            evidence: json({ owner: input, category: args.category, action: args.action, input: args.input, after: args.after ?? [], report: structuredClone(response) }),
          }, true)) } catch { response.assistance = { status: "uncertain", reason: "assistance-admission-needs-review" } }
        }
        return json(response)
      }
      if (name === "help") return json(await owner.requestHelp(actor, { id: actor.backendID + ":" + actor.threadID + ":" + args.requestID,
        goal: args.goal as string, issue: args.issue as string, evidence: args.evidence! }))
      throw new Error("Unknown research operation")
    } catch (error) {
      const message = error instanceof Error ? error.message : ""
      return { status: "error", reason: /^(Research|Invalid|Unknown|Publish)/.test(message) ? message : "Research result not confirmed; inspect stored records before repeating the operation" }
    }
  }
  function call(actor: Caller, name: string, raw: unknown, signal?: AbortSignal, messageID?: string): Promise<Data> {
    if (closed) return Promise.resolve({ status: "error", reason: "Research service is closed" })
    const work = execute(actor, name, raw, signal, messageID).finally(() => pending.delete(work))
    pending.add(work)
    return work
  }
  const tools: Info[] = definitions.map((item) => ({ ...item,
    execute: async (input, context) => ({ content: JSON.stringify(await call({ backendID: "opencode", threadID: context.sessionID }, item.name, input, context.signal, context.messageID)) }),
  }))
  return { definitions, call, tools, async close() { closed = true; await Promise.allSettled([...pending]) } }
}
