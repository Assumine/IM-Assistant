import { expect, test } from "bun:test"
import type { StorageDomain } from "../../../opencode/packages/plugin/src/promise/storage"
import { createDispatcher, type Data, type Outcome, type ResearchPath } from "../src/index"

function memory(): StorageDomain {
  const values = new Map<string, Data>()
  return {
    get: async (key) => structuredClone(values.get(key)),
    set: async (key, value) => { values.set(key, structuredClone(value)) },
    insert: async (key, value) => { if (values.has(key)) return false; values.set(key, structuredClone(value)); return true },
    remove: async (key) => { values.delete(key) },
    scan: async ({ prefix, after, limit = 100 }) => {
      const keys = [...values.keys()].filter((key) => key.startsWith(prefix) && (after === undefined || key > after)).sort()
      const page = keys.slice(0, limit)
      return { entries: page.map((key) => ({ key, value: structuredClone(values.get(key)!) })),
        ...(keys.length > page.length ? { next: page.at(-1) } : {}) }
    },
  }
}

const request = (roundID = "one") => ({ roundID, category: "film", action: "lookup", input: { query: "synthetic" } })
const success: Outcome = { status: "success", value: { title: "synthetic result" } }
const failed: Outcome = { status: "failure", reason: "read-only collector execution failed; safe to retry" }
function path(id: string, run: ResearchPath["run"] = async () => success): ResearchPath {
  return { id, revision: "1", category: "film", action: "lookup", title: id,
    accepts: (input) => input !== null && typeof input === "object" && "query" in input && typeof input.query === "string",
    validates: (output) => output !== null && typeof output === "object" && "title" in output && typeof output.title === "string", run }
}

test("only matching category, purpose and parameters can invoke a compiled function", async () => {
  const dispatcher = createDispatcher({ storage: memory(), paths: [path("a", async () => { throw new Error("must not run") })] })
  for (const input of [{ ...request(), category: "music" }, { ...request("two"), action: "download" }, { ...request("three"), input: {} }]) {
    expect((await dispatcher.run(input)).status).toBe("no-path")
  }
  expect((await dispatcher.history())[0]!.rounds).toBe(0)
})

test("a failure re-ranks paths and success skips all remaining work", async () => {
  const calls: string[] = []
  const dispatcher = createDispatcher({ storage: memory(), paths: [
    path("a", async () => { calls.push("a"); return failed }),
    path("b", async () => { calls.push("b"); return success }),
    path("c", async () => { calls.push("c"); return success }),
  ] })
  const report = await dispatcher.run(request())
  expect(report.status).toBe("success"); expect(calls).toEqual(["a", "b"])
  expect(report.paths.map((value) => value.historicalDelta)).toEqual([-0.1, 0.2, 0])
})

test("all negative round scores end the round, but the next round starts from history", async () => {
  const dispatcher = createDispatcher({ storage: memory(), paths: [path("a", async () => failed), path("b", async () => failed)] })
  const first = await dispatcher.run(request())
  expect(first.status).toBe("exhausted"); expect(first.attempts).toHaveLength(2)
  expect(first.paths.every((value) => value.score < 0)).toBe(true)
  const next = await dispatcher.run(request("two"))
  expect(next.paths.map((value) => value.initialScore)).toEqual([0.9, 0.9])
  expect(next.attempts).toHaveLength(2)
})

test("zero is eligible, strictly negative is ineligible", async () => {
  const atZero = createDispatcher({ storage: memory(), paths: [path("a", async () => failed)], scoring: { initial: 0 } })
  expect((await atZero.run(request())).attempts).toHaveLength(1)
  const negative = createDispatcher({ storage: memory(), paths: [path("a")], scoring: { initial: -0.1 } })
  expect((await negative.run(request())).attempts).toHaveLength(0)
})

test("there is no fixed attempt cap: a positive score can reach the eightieth attempt", async () => {
  const dispatcher = createDispatcher({ storage: memory(), paths: [path("a", async (_, context) => context.attempt === 80 ? success : failed)],
    scoring: { failurePenalty: 0.01 } })
  const report = await dispatcher.run(request())
  expect(report.status).toBe("success"); expect(report.attempts).toHaveLength(80)
  expect(report.paths[0]!.historicalDelta).toBeCloseTo(0.2 / 80)
})

test("many failures make only one small historical deduction", async () => {
  const dispatcher = createDispatcher({ storage: memory(), paths: [path("a", async () => failed)], scoring: { failurePenalty: 0.1 } })
  const report = await dispatcher.run(request())
  expect(report.attempts.length).toBeGreaterThan(5)
  expect(report.paths[0]!.historicalDelta).toBe(-0.1)
  expect((await dispatcher.history())[0]).toMatchObject({ score: 0.9, rounds: 1, failures: 1 })
})

test("a mature path survives a bad round and its historical correction is attenuated", async () => {
  const storage = memory()
  const healthy = createDispatcher({ storage, paths: [path("stable")] })
  for (let i = 0; i < 40; i++) await healthy.run(request("healthy-" + i))
  const before = (await healthy.history())[0]!
  const broken = createDispatcher({ storage, paths: [path("stable", async () => failed)] })
  const report = await broken.run(request("bad-round"))
  expect(report.attempts.length).toBeGreaterThan(1)
  expect(report.paths[0]!.historicalDelta).toBeCloseTo(-0.1 / Math.sqrt(41))
  expect((await broken.history())[0]!.score).toBeGreaterThan(0)
  expect((await broken.history())[0]!.score).toBeCloseTo(before.score - 0.1 / Math.sqrt(41))
})

test("historically successful paths precede new paths and can then fall back", async () => {
  const storage = memory()
  const seed = createDispatcher({ storage, paths: [path("z-stable")] })
  await seed.run(request("seed"))
  const dispatcher = createDispatcher({ storage, paths: [path("a-new"), path("z-stable", async () => failed)] })
  const report = await dispatcher.run(request("fallback"))
  expect(report.attempts.map((value) => value.pathID)).toEqual(["z-stable", "a-new"])
  expect(report.paths.find((value) => value.id === "z-stable")!.historicalDelta).toBeCloseTo(-0.1 / Math.sqrt(2))
})

test("revision changes start new implementation history without deleting prior facts", async () => {
  const storage = memory()
  await createDispatcher({ storage, paths: [path("a")] }).run(request())
  const dispatcher = createDispatcher({ storage, paths: [{ ...path("a"), revision: "2" }] })
  expect((await dispatcher.history())[0]).toMatchObject({ revision: "2", score: 1, rounds: 0 })
  expect((await storage.scan({ prefix: "round/result/" })).entries).toHaveLength(1)
})

test("invalid output is a failed attempt, never a successful delivery", async () => {
  const dispatcher = createDispatcher({ storage: memory(), paths: [path("a", async () => ({ status: "success", value: {} })), path("b")] })
  const report = await dispatcher.run(request())
  expect(report.status).toBe("success")
  expect(report.attempts[0]).toMatchObject({ status: "failure", reason: "invalid-script-output" })
  expect(report.attempts[1]!.pathID).toBe("b")
})

test("concurrent duplicate invocations share the original result and reject input conflicts", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let calls = 0
  const dispatcher = createDispatcher({ storage: memory(), paths: [path("a", async () => {
    calls++; entered.resolve(); await release.promise; return success
  })] })
  const first = dispatcher.run(request())
  await entered.promise
  const duplicate = dispatcher.run(request())
  await expect(dispatcher.run({ ...request(), input: { query: "changed" } })).rejects.toThrow("conflict")
  release.resolve()
  expect(await duplicate).toEqual(await first)
  expect(calls).toBe(1)
})

test("restart reads the completed receipt without repeating a script or historical update", async () => {
  const storage = memory()
  const first = await createDispatcher({ storage, paths: [path("a")] }).run(request())
  const next = createDispatcher({ storage, paths: [path("a", async () => { throw new Error("must not run") })] })
  expect(await next.run(request())).toEqual(first)
  expect((await next.history())[0]).toMatchObject({ score: 1.2, rounds: 1 })
})

test("another dispatcher cannot replay an incomplete external operation", async () => {
  const storage = memory(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const original = createDispatcher({ storage, paths: [path("a", async () => { entered.resolve(); await release.promise; return success })] })
  const first = original.run(request()); await entered.promise
  const restart = createDispatcher({ storage, paths: [path("a", async () => { throw new Error("must not run") })] })
  expect(await restart.run(request())).toMatchObject({ status: "uncertain", reason: "round-incomplete-review-required" })
  release.resolve(); await first
  expect((await restart.run(request())).status).toBe("success")
})

test("a thrown operation has an unknown result, no retry and no historical penalty", async () => {
  const dispatcher = createDispatcher({ storage: memory(), paths: [path("a", async () => { throw new Error("transport lost") }), path("b")] })
  const report = await dispatcher.run(request())
  expect(report.status).toBe("uncertain"); expect(report.attempts).toHaveLength(1)
  expect((await dispatcher.history()).every((value) => value.rounds === 0)).toBe(true)
})

test("login and captcha blocks retain the page problem and stop without retry", async () => {
  const dispatcher = createDispatcher({ storage: memory(), paths: [path("a", async () => ({ status: "blocked", reason: "captcha: keep current page" })), path("b")] })
  const report = await dispatcher.run(request())
  expect(report).toMatchObject({ status: "blocked", reason: "captcha: keep current page" })
  expect(report.attempts).toHaveLength(1)
  expect((await dispatcher.history())[0]!.score).toBe(1)
})

test("cancellation during a script cannot deliver success or lower history", async () => {
  const abort = new AbortController()
  const dispatcher = createDispatcher({ storage: memory(), paths: [path("a", async () => { abort.abort(); return success })] })
  const report = await dispatcher.run({ ...request(), signal: abort.signal })
  expect(report.status).toBe("cancelled"); expect(report.output).toBeUndefined()
  expect((await dispatcher.history())[0]!.rounds).toBe(0)
})

test("closing aborts the active function and rejects further work as cancelled", async () => {
  const entered = Promise.withResolvers<void>()
  const dispatcher = createDispatcher({ storage: memory(), paths: [path("a", async (_, { signal }) => {
    entered.resolve()
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
    return success
  })] })
  const running = dispatcher.run(request()); await entered.promise; await dispatcher.close()
  expect((await running).status).toBe("cancelled")
  expect((await dispatcher.run(request("later"))).status).toBe("cancelled")
})

test("request and per-attempt mutation cannot leak into subsequent calls", async () => {
  const input = request(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const queries: string[] = []
  const dispatcher = createDispatcher({ storage: memory(), paths: [path("a", async (value) => {
    const object = value as { query: string }; queries.push(object.query); object.query = "changed by script"
    entered.resolve(); await release.promise; return failed
  }), path("b", async (value) => { queries.push((value as { query: string }).query); return success })] })
  const running = dispatcher.run(input); await entered.promise; input.input.query = "changed by caller"; release.resolve(); await running
  expect(queries).toEqual(["synthetic", "synthetic"])
})

test("JSON property order does not change the identity of a repeated request", async () => {
  const dispatcher = createDispatcher({ storage: memory(), paths: [path("a")] })
  const first = await dispatcher.run({ ...request(), input: { query: "q", page: 1 } })
  expect(await dispatcher.run({ ...request(), input: { page: 1, query: "q" } })).toEqual(first)
  await expect(dispatcher.run({ ...request(), input: { query: "other", page: 1 } })).rejects.toThrow("conflict")
})

test("concurrent rounds append independent history facts without lost updates", async () => {
  const storage = memory(), release = Promise.withResolvers<void>(), both = Promise.withResolvers<void>()
  let entered = 0
  const dispatcher = createDispatcher({ storage, paths: [path("a", async () => {
    if (++entered === 2) both.resolve(); await release.promise; return success
  })] })
  const one = dispatcher.run(request("one")), two = dispatcher.run(request("two"))
  await both.promise; release.resolve(); const reports = await Promise.all([one, two])
  const history = (await dispatcher.history())[0]!
  expect(history.rounds).toBe(2)
  expect(history.score).toBeCloseTo(1 + reports.reduce((sum, value) => sum + value.paths[0]!.historicalDelta, 0))
})

test("a failed final persistence cannot claim success or replay unknown work", async () => {
  const storage = memory()
  const broken: StorageDomain = { ...storage, insert: async (key, value) => {
    if (key.startsWith("round/result/")) throw new Error("database unavailable")
    return storage.insert(key, value)
  } }
  await expect(createDispatcher({ storage: broken, paths: [path("a")] }).run(request())).rejects.toThrow("database unavailable")
  const restart = createDispatcher({ storage, paths: [path("a")] })
  expect((await restart.run(request())).status).toBe("uncertain")
  expect((await restart.history())[0]!.rounds).toBe(0)
})

test("invalid scoring or duplicate scripts fail before running", () => {
  for (const scoring of [{ failurePenalty: 0 }, { failurePenalty: -1 }, { initial: Infinity }, { successReward: NaN }]) {
    expect(() => createDispatcher({ storage: memory(), paths: [path("a")], scoring })).toThrow("Invalid scoring")
  }
  expect(() => createDispatcher({ storage: memory(), paths: [path("a"), path("a")] })).toThrow("duplicate")
})

test("cancellation during history loading stays cancelled even when there is no applicable path", async () => {
  const storage = memory(), abort = new AbortController()
  const dispatcher = createDispatcher({ storage: { ...storage, scan: async (options) => { abort.abort(); return storage.scan(options) } }, paths: [] })
  expect((await dispatcher.run({ ...request(), signal: abort.signal })).status).toBe("cancelled")
})

test("a verified negative finding is valid evidence and does not punish a working method", async () => {
  const dispatcher = createDispatcher({ storage: memory(), paths: [{ ...path("lookup"),
    validates: (value) => value !== null && typeof value === "object" && "found" in value && typeof value.found === "boolean",
    run: async () => ({ status: "success", value: { found: false, evidence: "Verified absence on the checked page" } }),
  }] })
  const report = await dispatcher.run(request())
  expect(report.status).toBe("success")
  expect(report.output).toMatchObject({ found: false })
  expect((await dispatcher.history())[0]).toMatchObject({ score: 1.2, failures: 0 })
})

test("ordinary function composition reuses a good trunk and scores only the replaceable failing branches", async () => {
  let identityCalls = 0
  const dispatcher = createDispatcher({ storage: memory(), paths: [
    { ...path("identify", async () => { identityCalls++; return success }), action: "identify" },
    { ...path("resource-a", async () => failed), action: "resource" },
    { ...path("resource-b", async () => failed), action: "resource" },
  ] })
  // A normal collector function, not a graph executor. Keep upstream output in this invocation.
  async function collect() {
    const identity = await dispatcher.run({ ...request("round:identify"), action: "identify" })
    expect(identity.status).toBe("success")
    const resource = await dispatcher.run({ ...request("round:resource"), action: "resource", input: { query: (identity.output as { title: string }).title } })
    return { identity: identity.output, resource }
  }
  const report = await collect()
  expect(report.resource.status).toBe("exhausted")
  expect(report.resource.attempts.map((value) => value.pathID)).toEqual(["resource-a", "resource-b"])
  expect(report.identity).toEqual(success.status === "success" ? success.value : undefined)
  expect(identityCalls).toBe(1)
  expect((await dispatcher.history()).find((value) => value.id === "identify")).toMatchObject({ score: 1.2, failures: 0 })
  expect((await dispatcher.history()).filter((value) => value.id.startsWith("resource")).map((value) => value.score)).toEqual([0.9, 0.9])
})
