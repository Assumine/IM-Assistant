import type { StorageDomain } from "../../../opencode/packages/plugin/src/promise/storage"
import { command, decode, fingerprint, inputID, originKey, scopeKey, type Message, type Policy, type Scope } from "./routing"
import { target, sameTarget, targets, type Target, type Native, type Backend, type Evidence } from "./target"
import { sources, type Origin, type Source, type SourceResult } from "./sources"

type Storage = Pick<StorageDomain, "get" | "set" | "insert">
export type Result =
  | { status: "ignored" | "unsupported" | "unbound" | "recalled" | "uncertain" | "unchanged" | "withdrawn" | "conflict" }
  | { status: "command"; action: string; arguments: string }
  | { status: "blocked"; reason: "cross-session-confirmation-required" | "quoted-adjustment-unavailable" | "quoted-task-not-pending" }
  | { status: "rejected"; reason: "not-accepted" }
  | { status: "accepted"; target: Target; sessionID?: string; inputID: string; duplicate: boolean; reference?: "unresolved" }
  | { status: "amended"; target: Target; inputID: string; amendmentID: string; duplicate: boolean }

/** Optional channel adapter. Native API remains the only execution and pending-input authority. No polling or task store. */
export function createPortal(options: { storage: Storage; session: Native; backend?: Backend; policy: Policy }) {
  const { storage, session, policy } = options
  const native = targets(session, options.backend)
  const metadata = sources(storage, policy)
  const key = (scope: Scope, id: string) => "origin:" + originKey(scope, id)
  const tombstone = (scope: Scope, id: string) => "recall:" + originKey(scope, id)
  const recalled = async (input: Message) => (await storage.get(tombstone(input.scope, input.messageID))) === input.actorID
  const lookup = metadata.lookup
  const binding = async (scope: Scope) => {
    const value = await storage.get("binding:" + scopeKey(scope))
    if (value === undefined || value === null) return undefined
    return target(value)
  }
  const accepted = (record: Origin, duplicate: boolean): Result => ({ status: "accepted", target: record.target,
    ...(record.target.kind === "session" ? { sessionID: record.target.sessionID } : {}), inputID: record.inputID, duplicate })
  const result = (record: Origin, evidence: Evidence, duplicate: boolean): Result => evidence === "amended" && record.amendmentID
    ? { status: "amended", target: record.target, inputID: record.inputID, amendmentID: record.amendmentID, duplicate }
    : evidence === "conflict" ? { status: "blocked", reason: "quoted-task-not-pending" } : evidence === "accepted" ? accepted(record, duplicate)
    : evidence === "rejected" ? { status: "rejected", reason: "not-accepted" } : { status: "uncertain" }
  const evidence = async (record: Origin): Promise<Evidence> => {
    try { return record.amendmentID ? await native.amendment(record.target, record.inputID, record.amendmentID) : await native.reconcile(record.target, record.inputID) }
    catch { return "uncertain" }
  }
  const withdraw = async (record: Origin): Promise<Result> => {
    try { return { status: await native.withdraw(record.target, record.inputID) } }
    catch { return { status: "uncertain" } }
  }
  return {
    /** Trusted host control API; remote transports must authorize controls before calling it. */
    async bind(scope: Scope, value?: string | Target) {
      if (scope.botID !== policy.botID) throw new Error("Wrong QQ bot")
      const destination = value === undefined ? undefined : target(value)
      if (destination) await native.validate(destination)
      await storage.set("binding:" + scopeKey(scope), destination ?? null)
    },
    /** Read-only lookup for future outbound transport. Never infer the recipient from the current binding. */
    async sourceFor(value: Target, inputID: string): Promise<SourceResult> {
      try {
        const destination = target(value)
        const found = await metadata.resolve(destination, inputID)
        if (found.status !== "found") return found
        const state = await native.reconcile(destination, inputID)
        return state === "accepted" ? found : { status: state === "rejected" ? "not-accepted" : "uncertain" }
      } catch { return { status: "uncertain" } }
    },
    async linkReply(source: Source, outgoingMessageID: string) {
      const record = await metadata.replyOrigin(source, outgoingMessageID)
      const state = await evidence(record)
      if (state !== "accepted" && state !== "amended") throw new Error("QQ source input is not confirmed accepted")
      await metadata.linkReply(source, outgoingMessageID)
    },
    async receive(raw: unknown): Promise<Result> {
      const event = decode(raw, policy)
      if (event.kind === "ignored" || event.kind === "unsupported") return { status: event.kind }
      if (event.kind === "recall") {
        const input = event.recall
        const record = await lookup(input.scope, input.messageID)
        // A reply/receipt alias belongs to the task but is not its originating user input.
        if (record && (record.actorID !== input.actorID || record.inputID !== inputID(input))) return { status: "unchanged" }
        await storage.insert(tombstone(input.scope, input.messageID), input.actorID)
        if (!record) return { status: "unchanged" }
        return withdraw(record)
      }
      const input = event.message
      const control = command(input.text)
      if (control) return { status: "command", ...control }
      if (await recalled(input)) return { status: "recalled" }
      const old = await lookup(input.scope, input.messageID)
      if (old) {
        if (old.fingerprint !== fingerprint(input)) return { status: "conflict" }
        await metadata.retain(old)
        return result(old, await evidence(old), true)
      }
      const destination = await binding(input.scope)
      if (!destination) return { status: "unbound" }
      const quoted = input.quoteID ? await lookup(input.scope, input.quoteID) : undefined
      if (quoted) {
        if (!sameTarget(quoted.target, destination)) return { status: "blocked", reason: "cross-session-confirmation-required" }
        if (!native.canAppend(destination)) return { status: "blocked", reason: "quoted-adjustment-unavailable" }
        try { if (!await native.pending(destination, quoted.inputID)) return { status: "blocked", reason: "quoted-task-not-pending" } }
        catch { return { status: "uncertain" } }
      }
      const record: Origin = { target: destination, inputID: quoted?.inputID ?? inputID(input), actorID: input.actorID, fingerprint: fingerprint(input),
        source: { scope: input.scope, messageID: input.messageID, actorID: input.actorID },
        ...(quoted ? { amendmentID: inputID(input) } : {}) }
      if (!(await storage.insert(key(input.scope, input.messageID), record))) {
        const winner = await lookup(input.scope, input.messageID)
        if (!winner) throw new Error("QQ origin admission was not retained")
        if (winner.fingerprint !== record.fingerprint) return { status: "conflict" }
        await metadata.retain(winner)
        return result(winner, await evidence(winner), true)
      }
      await metadata.retain(record)
      if (await recalled(input)) return { status: "recalled" }
      try {
        const state = record.amendmentID ? await native.append(record.target, record.inputID, record.amendmentID, input.text) : await native.send(record.target, record.inputID, input.text,
          { qq: { botID: input.scope.botID, kind: input.scope.kind, peerID: input.scope.peerID, actorID: input.actorID, messageID: input.messageID, ...(input.quoteID ? { quoteID: input.quoteID } : {}), mentions: input.mentions } })
        if (state !== "accepted") return result(record, state, false)
      } catch { return result(record, await evidence(record), true) }
      if (await recalled(input)) return withdraw(record)
      return { ...accepted(record, false), ...(input.quoteID ? { reference: "unresolved" as const } : {}) }
    },
  }
}

export { decode, command, type Message, type Policy, type Scope } from "./routing"
export { type Target, type Backend } from "./target"
export { type Source, type SourceResult } from "./sources"
