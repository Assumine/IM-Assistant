import { expect, test } from "bun:test"
import { createCheckpoints, createDispatcher, createOwner, researchService, type Data, type ResearchInput, type ResearchPath } from "../src/index"
import { first, memory, second } from "./fixture"

const input: ResearchInput = { ...first, inputID: "msg_original" }
const request = (action: string, roundID = action, value: Data = { title: "Film A" }, after?: string[]) =>
  ({ roundID, category: "film", action, input: value, ...(after ? { after } : {}) })
function path(id: string, action = id, extra: Partial<ResearchPath> = {}): ResearchPath {
  return { id, revision: "1", category: "film", action, title: id, readOnly: true, accepts: () => true, validates: () => true,
    run: async (value) => ({ status: "success", value }), ...extra }
}
function setup(paths: ResearchPath[], extra: { now?: () => number } = {}) {
  const storage = memory()
  const rounds = createCheckpoints({ storage, paths: async () => paths, isOpen: async () => true, ...extra })
  const history = createDispatcher({ storage, paths })
  return { storage, rounds, history }
}

test("downstream exhaustion never reruns or penalizes the valid trunk and history is folded only once at native closure", async () => {
  const calls: string[] = []
  const { rounds, history } = setup([path("identify", "identify", { run: async (value) => { calls.push("trunk"); return { status: "success", value } } }),
    path("source", "download", { run: async () => { calls.push("source"); return { status: "failure", reason: "safe read failed" } } })])
  const trunk = await rounds.run(input, request("identify"))
  const failed = await rounds.run(input, request("download", "resource", {}, [trunk.checkpoint!]))
  expect(failed).toMatchObject({ status: "exhausted" })
  const replay = await rounds.run(input, request("identify", "new-label"))
  expect(replay.reused).toBe(true)
  expect((await rounds.run(input, request("download", "another-label", {}, [trunk.checkpoint!]))).attempts).toHaveLength(0)
  expect(calls).toEqual(["trunk", "source"])
  expect((await history.history()).map((item) => item.score)).toEqual([1, 1])
  await Promise.all([rounds.finish(input, "completed"), rounds.finish(input, "completed")])
  expect((await history.history()).map((item) => [item.id, item.score, item.rounds])).toEqual([["identify", 1.2, 1], ["source", 0.9, 1]])
})

test("new call labels or parameters cannot reset a path's negative score within the same native input", async () => {
  let calls = 0
  const { rounds } = setup([path("unreliable", "details", { run: async () => { calls++; return { status: "failure", reason: "safe failure" } } })])
  await rounds.run(input, request("details", "one"))
  const second = await rounds.run(input, request("details", "two", { title: "Film B" }))
  expect(second.status).toBe("exhausted")
  expect(second.paths[0]!.score).toBe(-1)
  expect(calls).toBe(1)
})

test("an expired middle result resumes from the nearest valid ancestor and invalidates dependent results", async () => {
  let clock = 100, trunkCalls = 0, middleCalls = 0, tailCalls = 0
  const { rounds } = setup([
    path("trunk", "trunk", { run: async (value) => { trunkCalls++; return { status: "success", value } } }),
    path("middle", "middle", { validForMs: 10, run: async (value) => { middleCalls++; return { status: "success", value } } }),
    path("tail", "tail", { run: async (value) => { tailCalls++; return { status: "success", value } } }),
  ], { now: () => clock })
  const a = await rounds.run(input, request("trunk"))
  const b = await rounds.run(input, request("middle", "b", {}, [a.checkpoint!]))
  await rounds.run(input, request("tail", "c", {}, [b.checkpoint!]))
  clock = 111
  const stopped = await rounds.run(input, request("tail", "c", {}, [b.checkpoint!]))
  expect(stopped.status).toBe("blocked")
  expect(stopped.recovery!.checkpoints.map((item) => item.id)).toEqual([a.checkpoint!])
  const next = await rounds.run(input, request("middle", "b", {}, [a.checkpoint!]))
  expect(next.checkpoint).not.toBe(b.checkpoint)
  await rounds.run(input, request("tail", "c2", {}, [next.checkpoint!]))
  expect([trunkCalls, middleCalls, tailCalls]).toEqual([1, 2, 2])
})

test("input parameters and implementation revisions are part of result validity", async () => {
  let calls = 0
  const methods = [path("details", "details", { run: async (value) => { calls++; return { status: "success", value } } })]
  const { rounds } = setup(methods)
  const original = await rounds.run(input, request("details"))
  const other = await rounds.run(input, request("details", "other", { title: "Film B" }))
  expect(other.checkpoint).not.toBe(original.checkpoint)
  methods[0] = { ...methods[0]!, revision: "2" }
  const replaced = await rounds.run(input, request("details"))
  expect(replaced.checkpoint).not.toBe(original.checkpoint)
  expect(calls).toBe(3)
})

test("an expired effectful result requires review and cannot redownload under another label", async () => {
  let clock = 0, downloads = 0
  const { rounds } = setup([path("download", "download", { readOnly: false, validForMs: 10,
    run: async () => { downloads++; return { status: "success", value: { file: "already-downloaded" } } } })], { now: () => clock })
  await rounds.run(input, request("download")); clock = 20
  expect((await rounds.run(input, request("download", "new-label"))).status).toBe("uncertain")
  expect(downloads).toBe(1)
})

test("checkpoint references never cross native inputs or conversations", async () => {
  let tails = 0
  const { rounds } = setup([path("trunk"), path("tail", "tail", { run: async (value) => { tails++; return { status: "success", value } } })])
  const a = await rounds.run(input, request("trunk"))
  for (const owner of [{ ...input, inputID: "msg_other" }, { ...input, threadID: "ses_other" }]) {
    const result = await rounds.run(owner, request("tail", "tail", {}, [a.checkpoint!]))
    expect(result.reason).toBe("checkpoint-stale-or-not-owned")
  }
  expect(tails).toBe(0)
})

test("a verified negative finding is cached success rather than a method failure", async () => {
  let calls = 0
  const { rounds, history } = setup([path("lookup", "lookup", { run: async () => { calls++; return { status: "success", value: { found: false } } } })])
  expect((await rounds.run(input, request("lookup"))).output).toEqual({ found: false })
  expect((await rounds.run(input, request("lookup", "again"))).reused).toBe(true)
  await rounds.finish(input, "completed")
  expect((await history.history())[0]!.score).toBe(1.2)
  expect(calls).toBe(1)
})

test("unknown effects stop all further collection while preserving usable trunk evidence", async () => {
  let operations = 0
  const { rounds, history } = setup([path("trunk"), path("unknown", "unknown", { run: async () => { operations++; throw new Error("response lost after operation") } }),
    path("alternative", "other", { run: async (value) => { operations++; return { status: "success", value } } })])
  const trunk = await rounds.run(input, request("trunk"))
  expect((await rounds.run(input, request("unknown", "bad", {}, [trunk.checkpoint!]))).status).toBe("uncertain")
  expect((await rounds.run(input, request("other"))).status).toBe("uncertain")
  expect((await rounds.run(input, request("trunk", "read-evidence"))).reused).toBe(true)
  await rounds.finish(input, "completed")
  expect(operations).toBe(1)
  expect((await history.history()).every((item) => item.rounds === 0)).toBe(true)
})

test("restart retains valid checkpoints and shared scores without a new source read", async () => {
  let calls = 0
  const paths = [path("trunk", "trunk", { run: async (value) => { calls++; return { status: "success", value } } })]
  const { storage, rounds } = setup(paths)
  const first = await rounds.run(input, request("trunk")); await rounds.close()
  const restored = createCheckpoints({ storage, paths: async () => paths, isOpen: async () => true })
  const next = await restored.run(input, request("trunk", "resume"))
  expect(next.checkpoint).toBe(first.checkpoint)
  expect(next.reused).toBe(true)
  expect(calls).toBe(1)
})

test("a lost receipt is never replayed after restart, including an effect that may already have completed", async () => {
  const storage = memory()
  let failWrite = false, effects = 0
  const paths = [path("trunk"), path("effect", "effect", { readOnly: false, run: async (value) => { effects++; return { status: "success", value } } })]
  const faulty = { ...storage, insert: async (key: string, value: Data) => {
    if (failWrite && /\/step\/\d+\/result$/.test(key)) throw new Error("receipt write failed")
    return storage.insert(key, value)
  } }
  const original = createCheckpoints({ storage: faulty, paths: async () => paths, isOpen: async () => true })
  const trunk = await original.run(input, request("trunk")); failWrite = true
  await expect(original.run(input, request("effect", "effect", {}, [trunk.checkpoint!]))).rejects.toThrow("receipt write failed")
  await original.close()
  const restored = createCheckpoints({ storage, paths: async () => paths, isOpen: async () => true })
  const response = await restored.run(input, request("effect", "new-label", {}, [trunk.checkpoint!]))
  expect(response.reason).toBe("collection-incomplete-review-required")
  expect(response.recovery!.checkpoints[0]!.id).toBe(trunk.checkpoint!)
  expect(effects).toBe(1)
})

test("duplicate concurrent reads coalesce; a different concurrent collection is refused rather than queued", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let calls = 0
  const { rounds } = setup([path("slow", "slow", { run: async (value) => { calls++; entered.resolve(); await release.promise; return { status: "success", value } } }), path("other")])
  const first = rounds.run(input, request("slow")); await entered.promise
  const duplicate = rounds.run(input, request("slow", "duplicate"))
  expect((await rounds.run(input, request("other"))).reason).toBe("collection-already-running")
  release.resolve()
  expect(await first).toEqual(await duplicate)
  expect(calls).toBe(1)
})

test("native cancellation aborts the current collection and never adjusts historical reliability", async () => {
  const entered = Promise.withResolvers<void>(), controller = new AbortController()
  const { rounds, history } = setup([path("slow", "slow", { run: async (_, { signal }) => {
    entered.resolve(); await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
    return { status: "uncertain", reason: "operation cancelled" }
  } })])
  const running = rounds.run(input, { ...request("slow"), signal: controller.signal })
  await entered.promise; controller.abort()
  expect((await running).status).toBe("cancelled")
  await rounds.finish(input, "cancelled")
  expect((await history.history())[0]!.rounds).toBe(0)
})

test("a proven closed native input can read its receipt but cannot begin new I/O", async () => {
  let open = true, calls = 0
  const paths = [path("read", "read", { run: async (value) => { calls++; return { status: "success", value } } })]
  const rounds = createCheckpoints({ storage: memory(), paths: async () => paths, isOpen: async () => open })
  await rounds.run(input, request("read")); open = false
  await rounds.finish(input, "completed")
  expect((await rounds.run(input, request("read", "old"))).reused).toBe(true)
  expect((await rounds.run(input, request("read", "changed", {}))).reason).toBe("native-input-not-open")
  expect(calls).toBe(1)
})

test("repeated failures share one assistance admission containing native ownership and valid trunk context", async () => {
  const sent: string[] = []
  const owner = createOwner({ storage: memory(), primitives: [], isOpen: async () => true,
    paths: [path("trunk"), path("source", "source", { run: async () => ({ status: "failure", reason: "safe unavailable" }) })],
    deliver: async (_, __, text) => { sent.push(text); return { status: "accepted" } } })
  await owner.adopt(second, 0)
  const service = researchService(owner, undefined, async () => input)
  const trunk = await service.call(first, "run", request("trunk")) as Record<string, Data>
  expect(trunk).toMatchObject({ status: "success" })
  const args = { ...request("source", "one"), after: [trunk.checkpoint] }
  const failed = await service.call(first, "run", args) as Record<string, Data>
  expect(failed).toMatchObject({ status: "exhausted" })
  expect(() => JSON.stringify(failed)).not.toThrow()
  expect((await service.call(first, "run", { ...args, roundID: "two" }) as Record<string, Data>).status).toBe("exhausted")
  expect(sent).toHaveLength(1)
  const context = JSON.parse(sent[0]!).evidence
  expect(context.owner.inputID).toBe(input.inputID)
  expect(context.report.recovery.checkpoints).toHaveLength(1)
})

test("no model argument can supply native input ownership and unbound MCP execution fails closed", async () => {
  let calls = 0
  const owner = createOwner({ storage: memory(), primitives: [], paths: [path("read", "read", { run: async (value) => { calls++; return { status: "success", value } } })] })
  const service = researchService(owner)
  expect(await service.call(first, "run", request("read"))).toMatchObject({ status: "error" })
  expect(await service.call(first, "run", { ...request("read"), inputID: input.inputID })).toMatchObject({ status: "error" })
  expect(calls).toBe(0)
})

test("unknown assistance admission preserves the collection report and recovery evidence without duplicate delivery", async () => {
  let deliveries = 0
  const owner = createOwner({ storage: memory(), primitives: [], isOpen: async () => true,
    paths: [path("trunk"), path("unavailable", "unavailable", { run: async () => ({ status: "failure", reason: "safe unavailable" }) })],
    deliver: async () => { deliveries++; throw new Error("native admission response lost") } })
  await owner.adopt(second, 0)
  const service = researchService(owner, undefined, async () => input)
  const trunk = await service.call(first, "run", request("trunk")) as Record<string, Data>
  const args = { ...request("unavailable"), after: [trunk.checkpoint] }
  const result = await service.call(first, "run", args)
  expect(result).toMatchObject({ status: "exhausted", assistance: { status: "uncertain" }, recovery: { checkpoints: [{ id: trunk.checkpoint }] } })
  expect(await service.call(first, "run", { ...args, roundID: "retry-label" })).toMatchObject({ status: "exhausted", assistance: { status: "uncertain" } })
  expect(deliveries).toBe(1)
})
