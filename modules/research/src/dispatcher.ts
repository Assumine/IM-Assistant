import type { StorageDomain } from "../../../opencode/packages/plugin/src/promise/storage"
import type { Data, Outcome, PathHistory, PathSummary, Report, Request, ResearchPath, Scoring } from "./types"

export const defaultScoring: Readonly<Scoring> = Object.freeze({
  initial: 1,
  failurePenalty: 2,
  successReward: 0.2,
  historicalFailurePenalty: 0.1,
})

export function resolveScoring(value?: Partial<Scoring>): Scoring {
  const scoring = { ...defaultScoring, ...value }
  if (Object.values(scoring).some((weight) => !Number.isFinite(weight)) || scoring.failurePenalty <= 0 ||
    scoring.successReward <= 0 || scoring.historicalFailurePenalty <= 0) throw new Error("Invalid scoring weights")
  return scoring
}

/** Selects functions inside ONE research invocation; never owns a Session, Inbox or AI loop. */
export function historicalDelta(summary: PathSummary, past: PathHistory, scoring: Scoring): number {
  const delta = summary.successes ? scoring.successReward / (1 + summary.failures) : summary.failures ? -scoring.historicalFailurePenalty : 0
  return delta / Math.sqrt(1 + past.rounds)
}

export function createDispatcher(options: { storage: StorageDomain; paths: readonly ResearchPath[]; scoring?: Partial<Scoring>;
  frame?: { history: readonly PathHistory[]; previous: readonly PathSummary[] } }) {
  const scoring = resolveScoring(options.scoring)
  const paths = options.paths.map((value) => ({ ...value }))
  if (new Set(paths.map((value) => value.id)).size !== paths.length || paths.some((value) =>
    !value.id || !value.revision || !value.category || !value.action || !value.title)) throw new Error("Invalid or duplicate research path")
  const lifetime = new AbortController()
  const active = new Map<string, { fingerprint: string; promise: Promise<Report> }>()
  const storage = options.storage

  async function history(): Promise<PathHistory[]> {
    const result = paths.map((path) => ({ id: path.id, revision: path.revision, score: scoring.initial, rounds: 0, successes: 0, failures: 0 }))
    let after: string | undefined
    do {
      const page = await storage.scan({ prefix: "round/result/", after, limit: 100 })
      for (const entry of page.entries) {
        const receipt = entry.value as unknown as { report: Report }
        if (receipt.report?.schemaVersion !== 1) throw new Error("Unsupported research history")
        for (const summary of receipt.report.paths) {
          const value = result.find((item) => item.id === summary.id && item.revision === summary.revision)
          if (!value || summary.historicalDelta === 0) continue
          value.score += summary.historicalDelta
          value.rounds++
          value.successes += Number(summary.successes > 0)
          value.failures += Number(summary.successes === 0)
        }
      }
      after = page.next
    } while (after !== undefined)
    if (result.some((value) => !Number.isFinite(value.score))) throw new Error("Invalid research history score")
    return result
  }

  async function execute(request: Request, fingerprint: string): Promise<Report> {
    const signal = AbortSignal.any([lifetime.signal, ...(request.signal ? [request.signal] : [])])
    const report: Report = { schemaVersion: 1, roundID: request.roundID, status: "no-path", attempts: [], paths: [] }
    if (signal.aborted) return { ...report, status: "cancelled", reason: "research-cancelled" }
    const suffix = encodeURIComponent(request.roundID)
    const existing = await storage.get("round/intent/" + suffix)
    if (existing !== undefined && existing !== fingerprint) throw new Error("Research round input conflict")
    const finished = await storage.get("round/result/" + suffix) as unknown as { fingerprint: string; report: Report } | undefined
    if (finished) {
      if (finished.fingerprint !== fingerprint || finished.report.schemaVersion !== 1) throw new Error("Research round receipt conflict")
      return structuredClone(finished.report)
    }
    // An incomplete invocation is an unknown external result, not permission to repeat its work.
    if (!await storage.insert("round/intent/" + suffix, fingerprint)) {
      if (await storage.get("round/intent/" + suffix) !== fingerprint) throw new Error("Research round input conflict")
      return { ...report, status: "uncertain", reason: "round-incomplete-review-required" }
    }
    const histories = options.frame?.history ?? await history()
    const candidates = paths.filter((path) => path.category === request.category && path.action === request.action && path.accepts(structuredClone(request.input)))
      .map((path) => {
        const past = histories.find((item) => item.id === path.id && item.revision === path.revision) ??
          { id: path.id, revision: path.revision, score: scoring.initial, rounds: 0, successes: 0, failures: 0 }
        const previous = options.frame?.previous.find((item) => item.id === path.id && item.revision === path.revision)
        const summary = previous ? structuredClone(previous) : { id: path.id, revision: path.revision, initialScore: past.score, score: past.score,
          attempts: 0, successes: 0, failures: 0, historicalDelta: 0 }
        report.paths.push(summary)
        return { path, past, summary }
      })
    report.status = signal.aborted ? "cancelled" : candidates.length ? "exhausted" : "no-path"
    if (signal.aborted) report.reason = "research-cancelled"
    while (candidates.some((value) => value.summary.score >= 0)) {
      if (signal.aborted) { report.status = "cancelled"; report.reason = "research-cancelled"; break }
      const current = candidates.filter((value) => value.summary.score >= 0).sort((a, b) =>
        b.summary.score - a.summary.score || a.summary.attempts - b.summary.attempts || a.path.id.localeCompare(b.path.id))[0]!
      const before = current.summary.score
      current.summary.attempts++
      let outcome: Outcome
      try {
        outcome = await current.path.run(structuredClone(request.input), { signal, roundID: request.roundID, attempt: current.summary.attempts })
        if (outcome.status === "success" && !current.path.validates(outcome.value)) outcome = { status: "failure", reason: "invalid-script-output" }
      } catch {
        // A thrown transport/script error does not prove that an external operation failed safely.
        outcome = { status: "uncertain", reason: "script-result-unknown" }
      }
      if (signal.aborted) {
        report.status = "cancelled"; report.reason = "research-cancelled"
        report.attempts.push({ pathID: current.path.id, revision: current.path.revision, scoreBefore: before, scoreAfter: before, status: "cancelled" })
        break
      }
      if (outcome.status === "failure") {
        current.summary.score -= scoring.failurePenalty
        current.summary.failures++
        if (!(current.summary.score < before)) outcome = { status: "uncertain", reason: "score-did-not-decrease" }
      }
      if (outcome.status === "success") { current.summary.score += scoring.successReward; current.summary.successes++ }
      report.attempts.push({ pathID: current.path.id, revision: current.path.revision, scoreBefore: before,
        scoreAfter: current.summary.score, status: outcome.status, ...(outcome.status !== "success" ? { reason: outcome.reason } : {}) })
      if (outcome.status === "failure") continue
      report.status = outcome.status
      if (outcome.status === "success") report.output = structuredClone(outcome.value)
      if (outcome.status !== "success") report.reason = outcome.reason
      break
    }
    // Fold the round first. Ten failures in one round are ONE historical adjustment, not ten.
    if (!options.frame && (report.status === "success" || report.status === "exhausted")) {
      for (const { summary, past } of candidates) {
        summary.historicalDelta = historicalDelta(summary, past, scoring)
      }
    }
    // One immutable receipt is also the history fact: no competing mutable aggregate or partial score updates.
    const receipt = json({ fingerprint, report })
    if (!await storage.insert("round/result/" + suffix, receipt)) throw new Error("Research round already finalized")
    return structuredClone(report)
  }

  return {
    history,
    run(request: Request): Promise<Report> {
      if (!request.roundID || !request.category || !request.action) return Promise.reject(new Error("Invalid research request"))
      const snapshot = { ...request, input: structuredClone(request.input) }
      const fingerprint = canonical({ category: snapshot.category, action: snapshot.action, input: snapshot.input })
      const previous = active.get(snapshot.roundID)
      if (previous) return previous.fingerprint === fingerprint ? previous.promise.then((value) => structuredClone(value)) : Promise.reject(new Error("Research round input conflict"))
      const promise = execute(snapshot, fingerprint).finally(() => active.delete(snapshot.roundID))
      active.set(snapshot.roundID, { fingerprint, promise })
      return promise
    },
    async close() {
      lifetime.abort()
      await Promise.allSettled([...active.values()].map((value) => value.promise))
    },
  }
}

function json(value: object): Data { return JSON.parse(JSON.stringify(value)) }

function canonical(value: Data): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]"
  if (value !== null && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => JSON.stringify(key) + ":" + canonical(item)).join(",") + "}"
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Research input must be JSON")
  return JSON.stringify(value)
}
