import { expect, test } from "bun:test"
import { createOwner, researchService, type Data, type Outcome } from "../src/index"
import { definition, first, memory, request, second, source } from "./fixture"

async function setup(primitive = source) {
  const owner = createOwner({ storage: memory(), primitives: [primitive] })
  await owner.adopt(first, 0)
  await owner.save(first, definition)
  return owner
}

test("the assistance identity is transferable across backends and retains shared paths", async () => {
  const owner = await setup()
  expect(await owner.adopt(first, 1)).toEqual({ version: 1, holder: first })
  expect(await owner.adopt(second, 1)).toEqual({ version: 2, holder: second })
  expect(await owner.getDraft(definition.id, "1")).toEqual(definition)
  await expect(owner.save(first, { ...definition, revision: "2" })).rejects.toThrow("role changed")
  await owner.save(second, { ...definition, revision: "2" })
  expect(JSON.stringify(await owner.role())).not.toContain("model")
})

test("two concurrent claimants cannot both adopt the same observed role version", async () => {
  const owner = createOwner({ storage: memory(), primitives: [] })
  const results = await Promise.allSettled([owner.adopt(first, 0), owner.adopt(second, 0)])
  expect(results.filter((value) => value.status === "fulfilled")).toHaveLength(1)
  expect((await owner.role()).version).toBe(1)
})

test("immutable draft revisions reject edits and discovered candidates stay non-executable", async () => {
  const owner = await setup()
  await expect(owner.save(first, { ...definition, program: "return input" })).rejects.toThrow("revision conflict")
  await owner.candidate(first, { id: "alternate", pathID: definition.id, at: "resource lookup", direction: "Actual other source",
    evidence: "Alternative link observed on the synthetic page", expectedInput: "movie identity", expectedOutput: "details" })
  expect((await owner.catalog()).candidates).toHaveLength(1)
  expect((await owner.run(request)).status).toBe("no-path")
})

test("a draft must pass an actual confined execution before it can be published", async () => {
  let calls = 0
  const owner = await setup({ ...source, execute: async (input) => { calls++; return { status: "success", value: input } } })
  await expect(owner.publish(first, definition.id, "1", "test")).rejects.toThrow("successful test")
  await owner.test(first, { id: "test", pathID: definition.id, revision: "1", input: request.input })
  expect(calls).toBe(1)
  expect((await owner.history())).toEqual([])
  const published = await owner.publish(first, definition.id, "1", "test")
  expect(await owner.publish(first, definition.id, "1", "test")).toEqual(published)
  expect((await owner.run(request)).status).toBe("success")
  expect(calls).toBe(2)
  expect((await owner.history())[0]!.score).toBe(1.2)
})

test("testing a revision never authorizes publishing another revision", async () => {
  const owner = await setup()
  await owner.test(first, { id: "test", pathID: definition.id, revision: "1", input: request.input })
  await owner.save(first, { ...definition, revision: "2" })
  await expect(owner.publish(first, definition.id, "2", "test")).rejects.toThrow("this immutable revision")
})

test("duplicate tests return the recorded receipt and conflicting arguments never execute", async () => {
  let calls = 0
  const owner = await setup({ ...source, execute: async (input) => { calls++; return { status: "success", value: input } } })
  const input = { id: "test", pathID: definition.id, revision: "1", input: request.input }
  expect(await owner.test(first, input)).toEqual(await owner.test(first, input))
  await expect(owner.test(first, { ...input, input: { title: "Different movie" } })).rejects.toThrow("input conflict")
  expect(calls).toBe(1)
})

test("the interpreter does not expose process, fetch, require or host globals", async () => {
  const owner = await setup()
  await owner.save(first, { ...definition, revision: "sandbox", tools: [],
    program: 'return {status:"success",value:{title:typeof process+","+typeof fetch+","+typeof require+","+typeof Bun}}' })
  const result = await owner.test(first, { id: "sandbox", pathID: definition.id, revision: "sandbox", input: request.input }) as { outcome: Outcome }
  expect(result.outcome).toEqual({ status: "success", value: { title: "undefined,undefined,undefined,undefined" } })
})

test("unknown tools and unverified output cannot become a published path", async () => {
  const owner = await setup()
  await expect(owner.save(first, { ...definition, tools: ["shell"] })).rejects.toThrow("Unknown")
  await owner.save(first, { ...definition, revision: "bad", tools: [], program: 'return {status:"success",value:{}}' })
  const result = await owner.test(first, { id: "bad", pathID: definition.id, revision: "bad", input: request.input }) as { outcome: Outcome }
  expect(result.outcome.status).toBe("failure")
  await expect(owner.publish(first, definition.id, "bad", "bad")).rejects.toThrow("successful test")
})

test("repeated identical collector calls in one function reuse the observed result", async () => {
  let calls = 0
  const owner = await setup({ ...source, execute: async (input) => { calls++; return { status: "success", value: input } } })
  await owner.save(first, { ...definition, revision: "reuse", program: "await tools.read_page(input); return await tools.read_page(input)" })
  await owner.test(first, { id: "reuse", pathID: definition.id, revision: "reuse", input: request.input })
  expect(calls).toBe(1)
})

test("a captcha barrier prevents additional operations even if the authored program ignores it", async () => {
  let calls = 0
  const owner = await setup({ ...source, execute: async () => { calls++; return { status: "blocked", reason: "captcha: retain current page" } } })
  await owner.save(first, { ...definition, revision: "blocked", program: 'await tools.read_page(input); await tools.read_page({title:"another"}); return {status:"success",value:input}' })
  const result = await owner.test(first, { id: "blocked", pathID: definition.id, revision: "blocked", input: request.input }) as { outcome: Outcome }
  expect(result.outcome).toEqual({ status: "blocked", reason: "captcha: retain current page" })
  expect(calls).toBe(1)
})

test("handoff cancels the old holder's ongoing test and prevents stale publication", async () => {
  const entered = Promise.withResolvers<void>()
  const owner = await setup({ ...source, execute: async (_, { signal }) => {
    entered.resolve()
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
    return { status: "uncertain", reason: "collector cancelled" }
  } })
  const testing = owner.test(first, { id: "handoff", pathID: definition.id, revision: "1", input: request.input })
  const settled = testing.then(() => undefined, (error: unknown) => error)
  await entered.promise; await owner.adopt(second, 1)
  const failure = await settled
  expect(failure).toBeInstanceOf(Error)
  expect((failure as Error).message).toContain("role changed")
  await expect(owner.publish(second, definition.id, "1", "handoff")).rejects.toThrow("successful test")
})

test("a different holder after restart can read and continue the same stored material", async () => {
  const storage = memory(), original = createOwner({ storage, primitives: [source] })
  await original.adopt(first, 0); await original.save(first, definition)
  await original.test(first, { id: "test", pathID: definition.id, revision: "1", input: request.input })
  await original.close()
  const next = createOwner({ storage, primitives: [source] })
  await next.adopt(second, 1); await next.publish(second, definition.id, "1", "test")
  expect((await next.run(request)).status).toBe("success")
})

test("assistance goes to the current identity once and uses only the supplied native admission port", async () => {
  const sent: { target: unknown; id: string; text: string }[] = []
  const owner = createOwner({ storage: memory(), primitives: [], deliver: async (target, id, text) => {
    sent.push({ target, id, text }); return { status: "accepted" }
  } })
  await owner.adopt(first, 0)
  const input = { id: "one", goal: "Collect details", issue: "No verified path", evidence: {} }
  await owner.requestHelp(second, input); await owner.requestHelp(second, input)
  expect(sent).toHaveLength(1); expect(sent[0]!.target).toEqual(first)
  await expect(owner.requestHelp(second, { ...input, goal: "Changed" })).rejects.toThrow("conflict")
  await owner.adopt(second, 1); await owner.requestHelp(first, { ...input, id: "two" })
  expect(sent[1]!.target).toEqual(second)
})

test("unknown native admission is never blindly repeated", async () => {
  let calls = 0
  const owner = createOwner({ storage: memory(), primitives: [], deliver: async () => { calls++; throw new Error("admission lost") } })
  await owner.adopt(first, 0)
  const input = { id: "one", goal: "Collect", issue: "Unknown", evidence: {} }
  await expect(owner.requestHelp(second, input)).rejects.toThrow("admission lost")
  expect(await owner.requestHelp(second, input)).toMatchObject({ status: "uncertain" })
  expect(calls).toBe(1)
})

test("caller identity cannot be supplied in model tool arguments", async () => {
  const owner = await setup(), service = researchService(owner)
  expect(await service.call(second, "adopt", { expectedVersion: 1, holder: first })).toMatchObject({ status: "error" })
  expect((await owner.role()).holder).toEqual(first)
  expect(await service.call(second, "save", { definition: { ...definition, revision: "spoofed" } })).toMatchObject({ status: "error" })
})

test("stopping the capability prevents new authoring or execution without deleting its data", async () => {
  const owner = await setup()
  await owner.close()
  await expect(owner.run(request)).rejects.toThrow("closed")
  await expect(owner.save(first, { ...definition, revision: "2" })).rejects.toThrow("closed")
  expect(await owner.getDraft(definition.id, "1")).toEqual(definition)
})

test("a constant answer without collection evidence cannot be published as a working path", async () => {
  const owner = await setup()
  await owner.save(first, { ...definition, revision: "constant", tools: [], program: 'return {status:"success",value:{title:"Invented answer"}}' })
  await owner.test(first, { id: "constant", pathID: definition.id, revision: "constant", input: request.input })
  await expect(owner.publish(first, definition.id, "constant", "constant")).rejects.toThrow("collection evidence")
})

test("closing the tool service drains an existing native admission and refuses new calls", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const owner = createOwner({ storage: memory(), primitives: [], deliver: async () => { entered.resolve(); await release.promise; return { status: "accepted" } } })
  await owner.adopt(first, 0)
  const service = researchService(owner)
  const sending = service.call(second, "help", { requestID: "pending", goal: "Collect", issue: "Need a path", evidence: {} })
  await entered.promise
  const closing = service.close()
  expect(await service.call(first, "identity", {})).toMatchObject({ status: "error" })
  release.resolve(); await sending; await closing
  expect((await owner.catalog()).requests.length).toBeGreaterThan(0)
})

test("concurrent calls of one research round coalesce without a second execution or history update", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let testing = true, calls = 0
  const owner = await setup({ ...source, execute: async (input) => {
    calls++
    if (!testing) { entered.resolve(); await release.promise }
    return { status: "success", value: input }
  } })
  await owner.test(first, { id: "seed", pathID: definition.id, revision: "1", input: request.input })
  await owner.publish(first, definition.id, "1", "seed")
  testing = false
  const initial = owner.run(request)
  await entered.promise
  const duplicate = owner.run(request)
  await expect(owner.run({ ...request, input: { title: "Changed" } })).rejects.toThrow("input conflict")
  release.resolve()
  expect(await initial).toEqual(await duplicate)
  expect(calls).toBe(2)
  expect((await owner.history())[0]!.rounds).toBe(1)
})

test("the current role holder handles its own gap instead of enqueueing a self-request loop", async () => {
  let calls = 0
  const owner = createOwner({ storage: memory(), primitives: [], deliver: async () => { calls++; return { status: "accepted" } } })
  await owner.adopt(first, 0)
  expect(await owner.requestHelp(first, { id: "self", goal: "Repair path", issue: "Unknown branch", evidence: {} })).toMatchObject({ status: "already-assisting" })
  expect(calls).toBe(0)
  expect((await owner.catalog()).requests).toHaveLength(0)
})
