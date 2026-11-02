import type { StorageDomain } from "../../../opencode/packages/plugin/src/promise/storage"
import { createDispatcher, resolveScoring } from "./dispatcher"
import { candidate, digest, draft, json, same, stable, validIdentity, type Candidate, type CollectionEvidence, type Draft, type Identity, type Primitive, type Role } from "./contracts"
import { compilePath } from "./program"
import { createCheckpoints } from "./checkpoints"
import type { Data, Outcome, Report, Request, ResearchInput, ResearchPath, Scoring } from "./types"

export const assistanceInstructions = `Research assistance is a transferable role, not a model, provider or permanently assigned conversation.
Read role, paths, candidates and requests first. Adopt only when this conversation is assigned to take responsibility, not to bypass another holder's rejection. Changing the role never moves native history or interrupts unrelated tasks.
Open one complete collection function first. Use only authorized collector primitives; probe, save a new immutable revision, test it, then publish that exact tested revision.
Real alternatives discovered during initial exploration may be saved as candidate hints. They are not executable until verified.
Frequent actual failures justify replacing a local branch or an earlier source. Reuse valid trunk results; do not manufacture nodes or repeatedly open the same page.
A verified absence is a successful fact, not a method error. Captcha/login and unknown side effects must stop and be reported, never bypassed or blindly retried.
Research runners execute published functions only. Goals, new paths, recommendation decisions and repair belong to the current role holder.
Native Session/Inbox own tasks, queue, context and compaction. Do not create more sessions or a second task queue.`

export function createOwner(options: { storage: StorageDomain; primitives: readonly Primitive[]; paths?: readonly ResearchPath[]; scoring?: Partial<Scoring>;
  isOpen?: (input: ResearchInput) => Promise<boolean>;
  deliver?: (target: Identity, id: string, text: string) => Promise<Data> }) {
  const storage = options.storage, lifetime = new AbortController()
  const scoring = resolveScoring(options.scoring)
  if (new Set(options.primitives.map((item) => item.id)).size !== options.primitives.length ||
    options.primitives.some((item) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.id))) throw new Error("Invalid collector identities")
  const active = new Set<{ version: number; controller: AbortController; done: ReturnType<typeof Promise.withResolvers<void>> }>()
  const dispatchers = new Set<ReturnType<typeof createDispatcher>>()
  const runs = new Map<string, { fingerprint: string; work: Promise<Report> }>()
  // Serialize only short metadata commits; model execution and collector I/O never enter this critical section.
  let commit = Promise.resolve()
  function mutate<T>(work: () => Promise<T>): Promise<T> {
    const previous = commit, release = Promise.withResolvers<void>()
    commit = release.promise
    return previous.then(work).finally(() => release.resolve())
  }
  const key = (...parts: string[]) => parts.map(encodeURIComponent).join("/")
  async function entries(prefix: string) {
    const values: Data[] = []
    let after: string | undefined
    do { const page = await storage.scan({ prefix, after, limit: 100 }); values.push(...page.entries.map((value) => value.value)); after = page.next } while (after !== undefined)
    return values
  }
  async function role(): Promise<Role> {
    const events = await entries("assist/role/") as unknown as Role[]
    return events.sort((a, b) => b.version - a.version)[0] ?? { version: 0, holder: null }
  }
  async function assertOwner(actor: Identity, version?: number) {
    if (lifetime.signal.aborted) throw new Error("Research module is closed")
    const current = await role()
    if (!same(current.holder, actor) || version !== undefined && current.version !== version) throw new Error("Research assistance role changed; read current identity")
    return current
  }
  async function immutable(name: string, value: Data) {
    if (await storage.insert(name, value)) return
    if (stable((await storage.get(name))!) !== stable(value)) throw new Error("Research record revision conflict")
  }
  async function getDraft(id: string, revision: string): Promise<Draft> {
    const saved = await storage.get("path/draft/" + key(id, revision)) as unknown as { definition: Draft } | undefined
    if (!saved) throw new Error("Research draft not found")
    return saved.definition
  }
  async function published(): Promise<ResearchPath[]> {
    const records = await entries("path/published/") as unknown as { id: string; revision: string; order: number }[]
    const latest = new Map<string, typeof records[number]>()
    for (const record of records) if (!latest.has(record.id) || latest.get(record.id)!.order < record.order) latest.set(record.id, record)
    const compiled = await Promise.all([...latest.values()].map(async (value) => compilePath(await getDraft(value.id, value.revision), options.primitives)))
    return [...(options.paths ?? []).filter((path) => !latest.has(path.id)), ...compiled]
  }
  async function withOwner<T>(actor: Identity, signal: AbortSignal | undefined, work: (lease: Role, signal: AbortSignal) => Promise<T>) {
    const lease = await assertOwner(actor), call = { version: lease.version, controller: new AbortController(), done: Promise.withResolvers<void>() }
    active.add(call)
    const combined = AbortSignal.any([lifetime.signal, call.controller.signal, ...(signal ? [signal] : [])])
    try {
      const response = await work(lease, combined)
      await assertOwner(actor, lease.version)
      if (combined.aborted) throw new Error("Research operation cancelled or role handed over")
      return response
    } finally { active.delete(call); call.done.resolve() }
  }
  async function collect(request: Request) {
    const dispatcher = createDispatcher({ storage, paths: await published(), scoring })
    dispatchers.add(dispatcher)
    try { return await dispatcher.run({ ...request, signal: AbortSignal.any([lifetime.signal, ...(request.signal ? [request.signal] : [])]) }) }
    finally { await dispatcher.close(); dispatchers.delete(dispatcher) }
  }
  const checkpoints = createCheckpoints({ storage, paths: published, scoring, isOpen: options.isOpen ?? (async () => false) })
  return {
    collect: checkpoints.run,
    progress: checkpoints.inspect,
    finish: checkpoints.finish,
    pending: checkpoints.pending,
    inputOpen: (input: ResearchInput) => options.isOpen?.(input) ?? Promise.resolve(false),
    role,
    adopt: (actor: Identity, expectedVersion: number) => mutate(async () => {
      validIdentity(actor)
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new Error("Invalid role version")
      if (lifetime.signal.aborted) throw new Error("Research module is closed")
      const current = await role()
      if (current.version !== expectedVersion) throw new Error("Research role version conflict")
      if (same(current.holder, actor)) return current
      const next: Role = { version: expectedVersion + 1, holder: structuredClone(actor) }
      if (!await storage.insert("assist/role/" + String(next.version).padStart(16, "0"), json(next))) throw new Error("Research role version conflict")
      for (const call of active) if (call.version !== next.version) call.controller.abort()
      return next
    }),
    async catalog() {
      const drafts = await entries("path/draft/") as unknown as { definition: Draft }[]
      const requests = new Map<string, Data>()
      for (const value of await entries("assist/request/")) {
        const record = value as Record<string, Data>, existing = requests.get(record.id as string) as Record<string, Data> | undefined
        if (!existing || "admission" in record) requests.set(record.id as string, value)
      }
      return { role: await role(), instructions: assistanceInstructions,
        primitives: options.primitives.map(({ id, description, inputSchema, outputSchema, readOnly }) => ({ id, description, inputSchema, outputSchema, ...(readOnly === undefined ? {} : { readOnly }) })),
        drafts: drafts.map(({ definition: item }) => ({ id: item.id, revision: item.revision, category: item.category, action: item.action, title: item.title, tools: item.tools })),
        published: await entries("path/published/"), candidates: await entries("path/candidate/"), requests: [...requests.values()] }
    },
    getDraft,
    save: (actor: Identity, raw: unknown) => mutate(async () => {
      const lease = await assertOwner(actor), definition = draft(raw)
      compilePath(definition, options.primitives)
      await assertOwner(actor, lease.version)
      await immutable("path/draft/" + key(definition.id, definition.revision), json({ definition }))
      return definition
    }),
    candidate: (actor: Identity, raw: unknown): Promise<Candidate> => mutate(async () => {
      const lease = await assertOwner(actor), value = candidate(raw)
      await assertOwner(actor, lease.version)
      await immutable("path/candidate/" + key(value.id), json(value))
      return value
    }),
    probe: (actor: Identity, id: string, input: Data, signal?: AbortSignal) => withOwner(actor, signal, async (_, combined) => {
      const primitive = options.primitives.find((value) => value.id === id)
      if (!primitive) throw new Error("Unknown collector primitive")
      const definition: Draft = { id: "probe", revision: "1", title: "Authorized collector probe", category: "probe", action: "probe",
        tools: [id], program: "return await tools[" + JSON.stringify(id) + "](input)", inputSchema: primitive.inputSchema, outputSchema: primitive.outputSchema }
      const path = compilePath(definition, options.primitives)
      if (!path.accepts(input)) throw new Error("Invalid collector input")
      return path.run(input, { signal: combined, roundID: "probe", attempt: 1 })
    }),
    test: (actor: Identity, request: { id: string; pathID: string; revision: string; input: Data }, signal?: AbortSignal) => withOwner(actor, signal, async (lease, combined) => {
      const definition = await getDraft(request.pathID, request.revision), trace: CollectionEvidence[] = []
      const path = compilePath(definition, options.primitives, (value) => trace.push(value))
      if (!path.accepts(request.input)) throw new Error("Research test input does not match contract")
      const intent = json({ pathID: request.pathID, revision: request.revision, input: request.input })
      const name = "path/test/" + key(request.id)
      const saved = await storage.get(name) as unknown as { intent: Data; outcome: Outcome } | undefined
      if (saved) { if (stable(saved.intent) !== stable(intent)) throw new Error("Research test input conflict"); return saved }
      if (!await storage.insert(name + "/intent", intent)) throw new Error("Research test incomplete; inspect before retrying")
      const response = await path.run(request.input, { signal: combined, roundID: request.id, attempt: 1 })
      const receipt = await mutate(async () => {
        const current = await role()
        const final = combined.aborted || current.version !== lease.version ? { status: "uncertain", reason: "research-role-changed-or-cancelled" } : response
        const value = json({ intent, outcome: final, trace, by: actor, version: lease.version })
        await immutable(name, value)
        return value
      })
      return receipt
    }),
    publish: (actor: Identity, id: string, revision: string, testID: string) => mutate(async () => {
      const lease = await assertOwner(actor), definition = await getDraft(id, revision)
      const test = await storage.get("path/test/" + key(testID)) as unknown as { intent: { pathID: string; revision: string }; outcome: Outcome; trace?: CollectionEvidence[] } | undefined
      if (!test || test.intent.pathID !== id || test.intent.revision !== revision || test.outcome.status !== "success" || !test.trace?.some((item) => item.outcome.status === "success"))
        throw new Error("Publish requires a successful test of this immutable revision with collection evidence")
      compilePath(definition, options.primitives)
      await assertOwner(actor, lease.version)
      const existing = await storage.get("path/published/" + key(id, revision)) as unknown as { testID: string } | undefined
      if (existing) { if (existing.testID !== testID) throw new Error("Research publication conflict"); return existing }
      const previous = await entries("path/published/") as unknown as { id: string; order: number }[]
      const record = { id, revision, testID, order: Math.max(0, ...previous.filter((value) => value.id === id).map((value) => value.order)) + 1 }
      await immutable("path/published/" + key(id, revision), json(record))
      return record
    }),
    run(request: Request): Promise<Report> {
      if (lifetime.signal.aborted) return Promise.reject(new Error("Research module is closed"))
      const snapshot = { ...request, input: structuredClone(request.input) }
      const fingerprint = stable({ category: snapshot.category, action: snapshot.action, input: snapshot.input })
      const existing = runs.get(snapshot.roundID)
      if (existing) return existing.fingerprint === fingerprint ? existing.work.then((value) => structuredClone(value)) : Promise.reject(new Error("Research round input conflict"))
      // Coalesce only duplicate calls of this collection invocation, never native tasks or their queue.
      const work = collect(snapshot).finally(() => runs.delete(snapshot.roundID))
      runs.set(snapshot.roundID, { fingerprint, work })
      return work
    },
    async history() {
      const dispatcher = createDispatcher({ storage, paths: await published(), scoring })
      try { return await dispatcher.history() } finally { await dispatcher.close() }
    },
    async requestHelp(actor: Identity, request: { id: string; goal: string; issue: string; evidence: Data }, coalesce = false) {
      if (lifetime.signal.aborted) throw new Error("Research module is closed")
      const current = await role()
      const name = "assist/request/" + key(request.id)
      const saved = await storage.get(name)
      if (saved) {
        const record = saved as Record<string, Data>
        if (coalesce && stable(record.from!) === stable(json(actor))) return saved
        if (record.goal !== request.goal || record.issue !== request.issue || stable(record.evidence!) !== stable(request.evidence) || stable(record.from!) !== stable(json(actor)))
          throw new Error("Research assistance request conflict")
        return saved
      }
      if (!current.holder || !options.deliver) return { status: "blocked", reason: "research-assistance-unassigned-or-unavailable" }
      if (same(current.holder, actor)) return { status: "already-assisting", reason: "Handle this gap in the current assistance conversation; do not enqueue another request to yourself" }
      const intent = json({ ...request, from: actor, target: current.holder, roleVersion: current.version })
      if (!await storage.insert(name + "/intent", intent)) return { status: "uncertain", reason: "assistance-admission-needs-review" }
      const id = "msg_" + (await digest(json({ id: request.id }))).slice(0, 40)
      const admission = await options.deliver(current.holder, id, JSON.stringify({ purpose: "research-assistance", ...request, from: actor }))
      const record = json({ ...request, from: actor, target: current.holder, admission })
      await immutable(name, record)
      return record
    },
    async close() {
      lifetime.abort()
      const calls = [...active]
      for (const call of calls) call.controller.abort()
      await Promise.allSettled([commit, checkpoints.close(), ...calls.map((call) => call.done.promise), ...[...dispatchers].map((value) => value.close())])
    },
  }
}
