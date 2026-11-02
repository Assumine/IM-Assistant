import type { StorageDomain } from "../../../opencode/packages/plugin/src/promise/storage"
import { digest, json, stable, validIdentity } from "./contracts"
import { createDispatcher, historicalDelta, resolveScoring } from "./dispatcher"
import type { Checkpoint, CollectionReport, CollectionRequest, Data, PathHistory, PathSummary, Report, ResearchInput, ResearchPath, Scoring } from "./types"

interface Root { owner: ResearchInput; history: PathHistory[]; startedAt?: number; goal?: string; conversation?: string }
interface Step { request: Omit<CollectionRequest, "signal">; report: CollectionReport; checkpoint?: Checkpoint }
type Terminal = "completed" | "cancelled" | "uncertain"
const encode = (value: string) => encodeURIComponent(value)
const samePath = (a: { id: string; revision: string }, b: { id: string; revision: string }) => a.id === b.id && a.revision === b.revision

/** Collection facts scoped to an original native input. No AI queue, model loop or execution ownership. */
export function createCheckpoints(options: {
  storage: StorageDomain
  paths: () => Promise<readonly ResearchPath[]>
  isOpen: (input: ResearchInput) => Promise<boolean>
  scoring?: Partial<Scoring>
  now?: () => number
  describe?: (input: ResearchInput) => Promise<{ goal: string; conversation?: string }>
  changed?: () => void
}) {
  const storage = options.storage, scoring = resolveScoring(options.scoring), now = options.now ?? Date.now
  const lifetime = new AbortController()
  const active = new Map<string, { fingerprint: string; controller: AbortController; work: Promise<CollectionReport> }>()
  const finishing = new Map<string, Promise<Report | undefined>>()
  let restored = false
  const changed = () => { try { options.changed?.() } catch { /* Presentation cannot invalidate a collected fact. */ } }
  const activityKey = (id: string, root: Root) => "input/activity/" + String(Number.MAX_SAFE_INTEGER - (root.startedAt ?? 0)).padStart(16, "0") + "/" + id
  function key(input: ResearchInput) {
    validIdentity(input)
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.inputID)) throw new Error("Invalid native input identity")
    return encode(stable(json({ backendID: input.backendID, threadID: input.threadID, inputID: input.inputID })))
  }
  const prefix = (id: string) => "input/collection/" + id + "/"
  const resultKey = (id: string) => "round/result/" + encode("native:" + id)
  async function entries(start: string) {
    const all: { key: string; value: Data }[] = []
    let after: string | undefined
    do { const page = await storage.scan({ prefix: start, after, limit: 100 }); all.push(...page.entries); after = page.next } while (after !== undefined)
    return all
  }
  async function steps(id: string) {
    const base = prefix(id) + "step/"
    const all = (await entries(base)).filter((entry) => /^\d{12}\/(intent|result)$/.test(entry.key.slice(base.length)))
    const results = all.filter((entry) => entry.key.endsWith("/result")).map((entry) => entry.value as unknown as Step)
    const intents = all.filter((entry) => entry.key.endsWith("/intent"))
    return { results, intents, incomplete: intents.some((entry) => !all.some((other) => other.key === entry.key.replace(/intent$/, "result"))) }
  }
  function summaries(values: Step[]) {
    const all: PathSummary[] = []
    for (const step of values) for (const summary of step.report.paths) {
      const index = all.findIndex((item) => samePath(item, summary))
      if (index < 0) all.push(structuredClone(summary)); else all[index] = structuredClone(summary)
    }
    return all
  }
  function validity(values: Step[], paths: readonly ResearchPath[]) {
    const all = values.flatMap((step) => step.checkpoint ? [step.checkpoint] : [])
    const memo = new Map<string, boolean>(), visiting = new Set<string>()
    function valid(id: string): boolean {
      if (memo.has(id)) return memo.get(id)!
      const item = all.find((value) => value.id === id)
      const path = item && paths.find((value) => value.id === item.pathID && value.revision === item.revision)
      if (!item || !path || visiting.has(id)) return false
      visiting.add(id)
      let ok = false
      try { ok = (item.expiresAt === undefined || now() < item.expiresAt) && path.accepts(item.input) && path.validates(item.output) && item.parents.every(valid) }
      catch { /* Changed or broken contracts invalidate the result; they do not authorize replay. */ }
      visiting.delete(id); memo.set(id, ok)
      return ok
    }
    return { all, valid, usable: () => structuredClone(all.filter((item) => valid(item.id))) }
  }
  function report(input: ResearchInput, status: Report["status"], reason: string, checkpoints: Checkpoint[] = []): CollectionReport {
    return { schemaVersion: 1, roundID: input.inputID, status, reason, attempts: [], paths: [], recovery: { reason, checkpoints } }
  }
  async function initialize(input: ResearchInput, id: string, paths: readonly ResearchPath[]): Promise<Root> {
    const name = "input/owner/" + id
    let root = await storage.get(name) as unknown as Root | undefined
    if (!root) {
      const dispatch = createDispatcher({ storage, paths, scoring })
      let history: PathHistory[]
      try { history = await dispatch.history() } finally { await dispatch.close() }
      const description = await options.describe?.(input)
      await storage.insert(name, json({ owner: input, history, startedAt: now(), ...(description ?? {}) }))
      root = await storage.get(name) as unknown as Root
    }
    if (stable(json(root.owner)) !== stable(json(input))) throw new Error("Research input ownership conflict")
    if (!await storage.get(resultKey(id))) await storage.insert("input/watch/" + id, json(input))
    await storage.insert(activityKey(id, root), json(input))
    return root
  }
  async function collect(input: ResearchInput, request: CollectionRequest, signal: AbortSignal, id: string): Promise<CollectionReport> {
    if (!await storage.get("input/owner/" + id) && !await options.isOpen(input)) return report(input, "blocked", "native-input-not-open")
    const paths = await options.paths(), root = await initialize(input, id, paths)
    const saved = await steps(id), valid = validity(saved.results, paths)
    const parameters = { category: request.category, action: request.action, input: request.input, after: request.after ?? [] }
    const fingerprint = stable(json(parameters)), alias = prefix(id) + "alias/" + encode(request.roundID)
    if (!await storage.insert(alias, fingerprint) && await storage.get(alias) !== fingerprint) throw new Error("Research round input conflict")
    const matches = saved.results.filter((step) => stable(json({ category: step.request.category, action: step.request.action,
      input: step.request.input, after: step.request.after ?? [] })) === fingerprint)
    const previous = matches.at(-1)
    if (previous?.checkpoint && valid.valid(previous.checkpoint.id)) return { ...structuredClone(previous.report), reused: true }
    if (request.after?.some((parent) => !valid.valid(parent))) return report(input, "blocked", "checkpoint-stale-or-not-owned", valid.usable())
    if (saved.incomplete) return report(input, "uncertain", "collection-incomplete-review-required", valid.usable())
    if (previous?.checkpoint && !previous.checkpoint.readOnly) return report(input, "uncertain", "stale-effect-result-review-required", valid.usable())
    const barrier = saved.results.find((step) => ["blocked", "uncertain", "cancelled"].includes(step.report.status))
    if (barrier) return report(input, barrier.report.status, "collection-stopped-review-required: " + barrier.report.reason, valid.usable())
    if (signal.aborted || lifetime.signal.aborted) return report(input, "cancelled", "research-cancelled", valid.usable())
    if (await storage.get(resultKey(id)) || await storage.get(prefix(id) + "terminal") || !await options.isOpen(input))
      return report(input, "blocked", "native-input-not-open", valid.usable())
    const sequence = String(saved.intents.length).padStart(12, "0"), name = prefix(id) + "step/" + sequence
    const intent = json({ request: { ...parameters, roundID: request.roundID }, owner: input })
    if (!await storage.insert(name + "/intent", intent)) return report(input, "uncertain", "collection-concurrent-review-required", valid.usable())
    changed()
    const local: StorageDomain = {
      get: (key) => storage.get(name + "/dispatch/" + key),
      set: (key, value) => storage.set(name + "/dispatch/" + key, value),
      insert: (key, value) => storage.insert(name + "/dispatch/" + key, value),
      remove: (key) => storage.remove(name + "/dispatch/" + key),
      scan: async ({ prefix: start, after, limit }) => {
        const base = name + "/dispatch/"
        const page = await storage.scan({ prefix: base + start, ...(after === undefined ? {} : { after: base + after }), ...(limit === undefined ? {} : { limit }) })
        return { entries: page.entries.map((item) => ({ key: item.key.slice(base.length), value: item.value })),
          ...(page.next === undefined ? {} : { next: page.next.slice(base.length) }) }
      },
    }
    const guarded = paths.map((path) => ({ ...path, run: async (...args: Parameters<ResearchPath["run"]>) => {
      if (!await options.isOpen(input)) return { status: "uncertain" as const, reason: "native-input-no-longer-open" }
      return path.run(...args)
    } }))
    let ordinal = 0
    const dispatcher = createDispatcher({ storage: local, paths: guarded, scoring, frame: { history: root.history, previous: summaries(saved.results) },
      onSelect: async (value) => {
        if (!await storage.insert(name + "/selection/" + String(ordinal++).padStart(8, "0"), json(value))) throw new Error("Research selection receipt conflict")
        changed()
      },
    })
    let output: CollectionReport
    try { output = await dispatcher.run({ ...request, roundID: input.inputID, signal }) }
    finally { await dispatcher.close() }
    let checkpoint: Checkpoint | undefined
    if (output.status === "success") {
      const selected = output.attempts.findLast((item) => item.status === "success")!
      const path = paths.find((item) => item.id === selected.pathID && item.revision === selected.revision)!
      const createdAt = now()
      checkpoint = { id: await digest(json({ owner: input, sequence, fingerprint, pathID: path.id, revision: path.revision })),
        category: request.category, action: request.action, input: structuredClone(request.input), output: structuredClone(output.output!),
        pathID: path.id, revision: path.revision, parents: [...request.after ?? []], createdAt, readOnly: path.readOnly === true,
        ...(path.validForMs === undefined ? {} : { expiresAt: createdAt + path.validForMs }) }
      output.checkpoint = checkpoint.id
    }
    output.reused = false
    if (output.status !== "success") output.recovery = { reason: output.reason ?? output.status, checkpoints: valid.usable() }
    const step = json({ request: { ...parameters, roundID: request.roundID }, report: output, ...(checkpoint ? { checkpoint } : {}) })
    if (!await storage.insert(name + "/result", step)) throw new Error("Research collection receipt conflict")
    return structuredClone(output)
  }
  return {
    async pending() {
      // Rebuild a small non-authoritative watch index once after restart, rather than scan all history on every native event.
      if (!restored) {
        for (const entry of await entries("input/owner/")) {
          const root = entry.value as unknown as Root, id = key(root.owner)
          await storage.insert(activityKey(id, root), json(root.owner))
          if (!await storage.get(resultKey(id))) await storage.insert("input/watch/" + id, json(root.owner))
        }
        restored = true
      }
      const result: ResearchInput[] = []
      for (const entry of await entries("input/watch/")) {
        const input = entry.value as unknown as ResearchInput
        if (!await storage.get(resultKey(key(input)))) result.push(input)
        else await storage.remove(entry.key)
      }
      return result
    },
    async inspect(input: ResearchInput) {
      const id = key(input), paths = await options.paths(), saved = await steps(id), valid = validity(saved.results, paths)
      const final = await storage.get(resultKey(id)) as unknown as { report: Report } | undefined
      return { owner: input, finished: final !== undefined, ...(final ? { result: structuredClone(final.report) } : {}), incomplete: saved.incomplete,
        paths: summaries(saved.results), checkpoints: valid.usable(), steps: saved.results.map((step) => structuredClone(step.report)) }
    },
    async recent(signal: AbortSignal) {
      signal.throwIfAborted()
      const page = await storage.scan({ prefix: "input/activity/", limit: 12 }), watching = await storage.scan({ prefix: "input/watch/", limit: 12 }), result = []
      const distinct = new Map([...watching.entries, ...page.entries].map((entry) => [key(entry.value as unknown as ResearchInput), entry]))
      for (const entry of distinct.values()) {
        signal.throwIfAborted()
        const input = entry.value as unknown as ResearchInput, id = key(input), root = await storage.get("input/owner/" + id) as unknown as Root
        const saved = await steps(id), all = await entries(prefix(id) + "step/")
        const current = saved.intents.at(-1)?.key.replace(/\/intent$/, "/selection/")
        const selections = all.filter((entry) => current && entry.key.startsWith(current))
        const final = await storage.get(resultKey(id)) as unknown as { report: Report } | undefined
        const last = saved.results.at(-1), intent = saved.intents.at(-1)?.value as unknown as { request: Omit<CollectionRequest, "signal"> } | undefined
        const selected = selections.at(-1)?.value as unknown as { pathID: string; revision: string; score: number; attempt: number } | undefined
        result.push({ owner: input, goal: root.goal, conversation: root.conversation, startedAt: root.startedAt,
          running: active.has(id), incomplete: saved.incomplete, history: root.history, paths: summaries(saved.results),
          last: last?.report, request: intent?.request, selected, result: final?.report })
      }
      return result
    },
    run(input: ResearchInput, request: CollectionRequest): Promise<CollectionReport> {
      if (lifetime.signal.aborted) return Promise.reject(new Error("Research module is closed"))
      if (!request.roundID || !request.category || !request.action || request.after && new Set(request.after).size !== request.after.length)
        return Promise.reject(new Error("Invalid research collection request"))
      const id = key(input), snapshot = { ...request, input: structuredClone(request.input), ...(request.after ? { after: [...request.after] } : {}) }
      const fingerprint = stable(json({ category: snapshot.category, action: snapshot.action, input: snapshot.input, after: snapshot.after ?? [] }))
      const previous = active.get(id)
      if (previous) return previous.fingerprint === fingerprint ? previous.work.then((value) => structuredClone(value))
        : Promise.resolve(report(input, "blocked", "collection-already-running"))
      const controller = new AbortController(), signal = AbortSignal.any([lifetime.signal, controller.signal, ...(request.signal ? [request.signal] : [])])
      const work = collect(input, snapshot, signal, id).finally(() => { active.delete(id); changed() })
      active.set(id, { fingerprint, controller, work })
      return work
    },
    finish(input: ResearchInput, terminal: Terminal): Promise<Report | undefined> {
      const id = key(input), existing = finishing.get(id)
      if (existing) return existing
      const work = (async () => {
        const root = await storage.get("input/owner/" + id) as unknown as Root | undefined
        if (!root) return undefined
        const finished = await storage.get(resultKey(id)) as unknown as { report: Report } | undefined
        if (finished) return structuredClone(finished.report)
        await storage.insert(prefix(id) + "terminal", terminal)
        const ended = await storage.get(prefix(id) + "terminal") as Terminal
        const current = active.get(id)
        if (current) { current.controller.abort(); await current.work.catch(() => {}) }
        const saved = await steps(id), paths = summaries(saved.results), last = saved.results.at(-1)?.report
        const report: Report = { schemaVersion: 1, roundID: input.inputID, status: ended === "cancelled" ? "cancelled"
          : ended === "uncertain" || saved.incomplete ? "uncertain" : last?.status ?? "no-path",
          attempts: saved.results.flatMap((step) => step.report.attempts), paths }
        if (last?.output !== undefined) report.output = structuredClone(last.output)
        if (last?.reason) report.reason = last.reason
        if (ended !== "completed" || saved.incomplete) report.reason = saved.incomplete ? "collection-incomplete-review-required" : "native-input-" + ended
        if (ended === "completed" && !saved.incomplete && saved.results.every((step) => ["success", "exhausted", "no-path"].includes(step.report.status)))
          for (const summary of paths) summary.historicalDelta = historicalDelta(summary,
            root.history.find((item) => samePath(item, summary)) ?? { id: summary.id, revision: summary.revision, score: summary.initialScore, rounds: 0, successes: 0, failures: 0 }, scoring)
        const receipt = json({ fingerprint: stable(json(input)), report })
        if (!await storage.insert(resultKey(id), receipt) && stable((await storage.get(resultKey(id)))!) !== stable(receipt))
          throw new Error("Research input finalization conflict")
        await storage.remove("input/watch/" + id)
        changed()
        return structuredClone(report)
      })().finally(() => finishing.delete(id))
      finishing.set(id, work)
      return work
    },
    async close() {
      lifetime.abort()
      await Promise.allSettled([...active.values()].map((item) => item.work))
      await Promise.allSettled([...finishing.values()])
    },
  }
}
