import type { createPortal, Result } from "./index"
import { decode, scopeKey, type Policy, type Message } from "./routing"
import type { Source } from "./sources"
import { openOneBot, type OneBotOptions, type SendResult, type WireState } from "./onebot"

export type ChannelIssue = { kind: "unsupported" | "overloaded" | "not-forwarded" | "uncertain" | "handler-error" | "callback-error" | "notification-uncertain" | "notification-unavailable" | "notification-rejected" | "notification-unlinked"; source?: Source }
export type ChannelOptions = {
  portal: Pick<ReturnType<typeof createPortal>, "receive">; policy: Policy; connection: Omit<OneBotOptions, "botID">
  maxPendingEvents?: number
  /** Finish admission/notification work only; never wait for model completion in this ingress lane. */
  onResult: (value: { source: Source; result: Result; message?: Message }) => void | Promise<void>
  onIssue?: (value: ChannelIssue) => void
  onState?: (value: WireState) => void
}

/** One caller-owned channel, outside per-Location plugin setup. Only ingress admission is sequenced; native tasks run independently. */
export function openQQChannel(options: ChannelOptions) {
  let closing = false, count = 0, active = 0
  const blocked = new Set<string>(), lanes = new Map<string, Promise<void>>(), jobs = new Set<Promise<void>>()
  const limit = Number.isSafeInteger(options.maxPendingEvents) && options.maxPendingEvents! > 0 && options.maxPendingEvents! <= 512 ? options.maxPendingEvents! : 128
  const issue = (value: ChannelIssue) => { try { options.onIssue?.(value) } catch { /* Reporting must not replay ingress or break another scope. */ } }
  const permitted = (source: Source) => source.scope.botID === options.policy.botID && options.policy.allowedUsers.includes(source.actorID) &&
    (source.scope.kind === "private" ? source.scope.peerID === source.actorID : options.policy.allowedGroups.includes(source.scope.peerID))
  const wire = openOneBot({ ...options.connection, botID: options.policy.botID }, {
    state: options.onState,
    event: (raw) => {
      if (closing) return
      const event = decode(raw, options.policy)
      if (event.kind === "ignored") return
      if (event.kind === "unsupported") { issue({ kind: "unsupported" }); return }
      const message = event.kind === "message" ? event.message : event.recall
      const source: Source = { scope: message.scope, actorID: message.actorID, messageID: message.messageID }
      const key = scopeKey(source.scope)
      if (blocked.has(key)) { issue({ kind: "not-forwarded", source }); return }
      if (count >= limit) { closing = true; wire.close(); issue({ kind: "overloaded", source }); return }
      count++
      const previous = lanes.get(key) ?? Promise.resolve()
      const job = previous.then(async () => {
        if (closing || blocked.has(key)) { issue({ kind: "not-forwarded", source }); return }
        active++
        try {
          const result = await options.portal.receive(raw)
          if (result.status === "uncertain" || result.status === "control" && result.result.kind === "uncertain" ||
            result.status === "confirmation-control" && result.result.status === "uncertain") {
            blocked.add(key); issue({ kind: "uncertain", source })
          }
          if (!closing) {
            try { await options.onResult({ source, result, ...(event.kind === "message" ? { message: event.message } : {}) }) } catch { issue({ kind: "callback-error", source }) }
          }
        } catch { blocked.add(key); issue({ kind: "handler-error", source }) }
        finally { active-- }
      }).finally(() => { count--; jobs.delete(job); if (lanes.get(key) === job) lanes.delete(key) })
      lanes.set(key, job); jobs.add(job)
    },
  })
  return {
    ready: wire.ready,
    state: () => ({ ...wire.state(), pendingEvents: count, activeAdmissions: active, blockedScopes: blocked.size }),
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
      await Promise.allSettled(jobs)
    },
  }
}
