import type { createPortal, Result } from "./index"
import { decode, scopeKey, originKey, type Policy, type Message } from "./routing"
import type { Source } from "./sources"
import { openOneBot, type OneBotOptions, type SendResult, type WireState } from "./onebot"
import type { StorageDomain } from "../../../opencode/packages/plugin/src/promise/storage"
import { createHistory, type HistoryConfig, type HistoryEntry, type HistoricalInput } from "./history"

export type ChannelIssue = { kind: "unsupported" | "overloaded" | "not-forwarded" | "uncertain" | "handler-error" | "callback-error" | "notification-uncertain" | "notification-unavailable" | "notification-rejected" | "notification-unlinked" | "history-unavailable"; source?: Source }
export type RecoveryState = { scope: Source["scope"]; phase: "loading" | "ready" | "unavailable"; recovered: number }
export type ChannelOptions = {
  portal: Pick<ReturnType<typeof createPortal>, "receive">; policy: Policy; connection: Omit<OneBotOptions, "botID">
  maxPendingEvents?: number
  /** Finish admission/notification work only; never wait for model completion in this ingress lane. */
  onResult: (value: { source: Source; result: Result; message?: Message }) => void | Promise<void>
  onIssue?: (value: ChannelIssue) => void
  onState?: (value: WireState) => void
  history?: { config: HistoryConfig; storage: Pick<StorageDomain, "get" | "set" | "scan"> }
  onRecovery?: (value: RecoveryState) => void
}

/** One caller-owned channel, outside per-Location plugin setup. Only ingress admission is sequenced; native tasks run independently. */
export function openQQChannel(options: ChannelOptions) {
  let closing = false, count = 0, active = 0
  const blocked = new Set<string>(), lanes = new Map<string, Promise<void>>(), jobs = new Set<Promise<void>>()
  const barriers = new Map<string, Promise<void>>(), recalls = new Map<string, Set<() => Promise<void>>>()
  const live = new Map<string, HistoryEntry>()
  const historyReads = new Set<Promise<void>>()
  let discovery = Promise.resolve(), recovering = 0, recovered = 0
  const limit = Number.isSafeInteger(options.maxPendingEvents) && options.maxPendingEvents! > 0 && options.maxPendingEvents! <= 512 ? options.maxPendingEvents! : 128
  const issue = (value: ChannelIssue) => { try { options.onIssue?.(value) } catch { /* Reporting must not replay ingress or break another scope. */ } }
  const permitted = (source: Source) => source.scope.botID === options.policy.botID && options.policy.allowedUsers.includes(source.actorID) &&
    (source.scope.kind === "private" ? source.scope.peerID === source.actorID : options.policy.allowedGroups.includes(source.scope.peerID))
  const history = options.history ? createHistory({ ...options.history, policy: options.policy, read: async (scope, before, count) => {
    // Bound read-only recovery I/O below the shared wire request limit; this does not schedule native tasks.
    while (historyReads.size >= 4) await Promise.race(historyReads)
    if (closing) return undefined
    const request = wire.history(scope, before, count), settled = request.then(() => undefined, () => undefined)
    historyReads.add(settled)
    try { return await request } finally { historyReads.delete(settled) }
  } }) : undefined
  const track = (job: Promise<void>) => { jobs.add(job); void job.finally(() => jobs.delete(job)); return job }
  const recoveryState = (value: RecoveryState) => { try { options.onRecovery?.(value) } catch { /* Observation only. */ } }
  const consume = async (raw: unknown, context?: HistoricalInput, position?: HistoryEntry, verifiedHistory = false): Promise<boolean> => {
    if (closing) return false
    const event = decode(raw, options.policy)
    const scope = event.kind === "message" ? event.message.scope : event.kind === "recall" ? event.recall.scope : position?.scope
    const source: Source | undefined = event.kind === "message" ? { scope: event.message.scope, actorID: event.message.actorID, messageID: event.message.messageID }
      : event.kind === "recall" ? event.recall : position ? { scope: position.scope, actorID: String(position.raw.user_id), messageID: position.messageID } : undefined
    try {
      if (history && position) await history.check(position)
      if (event.kind === "unsupported") issue({ kind: "unsupported", source })
      if (event.kind === "message" && history && !position) throw new Error("Historical sequence unavailable")
      if (event.kind === "message" || event.kind === "recall") {
        active++
        try {
          const result = await options.portal.receive(raw, context)
          if (result.status === "uncertain" || result.status === "control" && result.result.kind === "uncertain" ||
            result.status === "confirmation-control" && result.result.status === "uncertain") {
            blocked.add(scopeKey(source!.scope)); issue({ kind: "uncertain", source }); return false
          }
          if (closing) return false
          try { await options.onResult({ source: source!, result, ...(event.kind === "message" ? { message: event.message } : {}) }) }
          catch {
            issue({ kind: "callback-error", source })
            if (history) { blocked.add(scopeKey(source!.scope)); return false }
          }
        } catch { blocked.add(scopeKey(source!.scope)); issue({ kind: "handler-error", source }); return false }
        finally { active-- }
      }
      if (history && position) await history.commit(position, verifiedHistory)
      return true
    } catch {
      if (scope) blocked.add(scopeKey(scope))
      issue({ kind: "history-unavailable", source }); return false
    }
  }
  const flushRecalls = async (key: string) => {
    const pending = recalls.get(key)
    if (!pending) return
    for (const recall of pending) { pending.delete(recall); await recall() }
    if (!pending.size) recalls.delete(key)
  }
  const recover = () => {
    if (!history) return
    const discovered = Promise.withResolvers<void>()
    discovery = discovered.promise
    track((async () => {
      try {
        const scopes = await history.scopes()
        for (const scope of scopes) {
          if (closing) break
          const key = scopeKey(scope), gate = Promise.withResolvers<void>()
          barriers.set(key, gate.promise); recovering++
          track((async () => {
            let completed = 0
            recoveryState({ scope, phase: "loading", recovered: 0 })
            try {
              const entries = await history.collect(scope), recoveredAt = Date.now()
              for (const position of entries) {
                await flushRecalls(key)
                if (closing) return
                const current = live.get(originKey(position.scope, position.messageID))
                if (current && (current.sequence !== position.sequence || current.sentAt !== position.sentAt)) throw new Error("Different live history identity")
                if (blocked.has(key) || !await consume(current?.raw ?? position.raw, current ? undefined : { sentAt: position.sentAt, recoveredAt }, current ?? position, true)) throw new Error("QQ recovery stopped")
                if (!current) { completed++; recovered++ }
              }
              if (!closing) recoveryState({ scope, phase: "ready", recovered: completed })
            } catch {
              if (!closing) { blocked.add(key); issue({ kind: "history-unavailable" }); recoveryState({ scope, phase: "unavailable", recovered: completed }) }
            } finally {
              if (!closing) await flushRecalls(key)
              recovering--; gate.resolve()
              if (barriers.get(key) === gate.promise) barriers.delete(key)
            }
          })())
        }
      } catch { if (!closing) issue({ kind: "history-unavailable" }) }
      finally { discovered.resolve() }
    })())
  }
  const wire = openOneBot({ ...options.connection, botID: options.policy.botID }, {
    state: (value) => { if (value.phase === "online") recover(); options.onState?.(value) },
    event: (raw) => {
      if (closing) return
      const event = decode(raw, options.policy)
      const position = history?.entry(raw)
      if (event.kind === "ignored" && !position) return
      if (event.kind === "unsupported" && !position) { issue({ kind: "unsupported" }); return }
      const message = event.kind === "message" ? event.message : event.kind === "recall" ? event.recall : undefined
      const source: Source | undefined = message ? { scope: message.scope, actorID: message.actorID, messageID: message.messageID } : undefined
      const key = scopeKey(source?.scope ?? position!.scope)
      if (blocked.has(key)) { issue({ kind: "not-forwarded", source }); return }
      if (count >= limit) { closing = true; wire.close(); issue({ kind: "overloaded", source }); return }
      count++
      const liveKey = position ? originKey(position.scope, position.messageID) : undefined
      if (position && !live.has(liveKey!)) live.set(liveKey!, position)
      let done = false
      const run = async () => { if (done) return; done = true; await consume(raw, undefined, position) }
      if (history && event.kind === "recall") {
        const pending = recalls.get(key) ?? new Set<() => Promise<void>>()
        pending.add(run); recalls.set(key, pending)
      }
      const previous = lanes.get(key) ?? Promise.resolve()
      const job = previous.then(async () => {
        await discovery
        await barriers.get(key)
        if (closing || blocked.has(key)) { issue({ kind: "not-forwarded", source }); return }
        await run()
      }).finally(() => { count--; jobs.delete(job); if (liveKey && live.get(liveKey) === position) live.delete(liveKey); recalls.get(key)?.delete(run); if (!recalls.get(key)?.size) recalls.delete(key); if (lanes.get(key) === job) lanes.delete(key) })
      lanes.set(key, job); track(job)
    },
  })
  return {
    ready: wire.ready,
    state: () => ({ ...wire.state(), pendingEvents: count, activeAdmissions: active, blockedScopes: blocked.size, recoveringScopes: recovering, recoveredMessages: recovered }),
    /** Trusted confirmation adapter only. Authorization precedes the exact OneBot message read. */
    read(source: Source) { return closing || !permitted(source) ? Promise.resolve(undefined) : wire.read(source) },
    /** Host-only primitive. Durable output identity, native completion and notification retry policy belong to the sender, not this wire. */
    async send(source: Source, text: string): Promise<SendResult | { status: "forbidden" }> {
      if (closing) return { status: "unavailable" }
      if (!permitted(source)) return { status: "forbidden" }
      return wire.send(source.scope, text, source.messageID)
    },
    /** Stop ingress before the application scope releases its public clients/storage. Begun admissions settle; native execution is never interrupted. */
    async close() {
      closing = true; wire.close()
      while (jobs.size) await Promise.allSettled(jobs)
    },
  }
}
