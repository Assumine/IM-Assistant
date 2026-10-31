import type { StorageDomain } from "../../../opencode/packages/plugin/src/promise/storage"
import { command, decode, fingerprint, inputID, originKey, scopeKey, type Message, type Policy, type Scope } from "./routing"
import { target, sameTarget, targets, type Target, type Native, type Backend, type Evidence } from "./target"

type Storage = Pick<StorageDomain, "get" | "set" | "insert">
type Origin = { target: Target; inputID: string; actorID: string; fingerprint: string; amendmentID?: string }
export type Result =
  | { status: "ignored" | "unsupported" | "unbound" | "recalled" | "uncertain" | "unchanged" | "withdrawn" | "conflict" }
  | { status: "command"; action: string; arguments: string }
  | { status: "blocked"; reason: "cross-session-confirmation-required" | "quoted-adjustment-unavailable" | "quoted-task-not-pending" }
  | { status: "rejected"; reason: "not-accepted" }
  | { status: "accepted"; target: Target; sessionID?: string; inputID: string; duplicate: boolean; reference?: "unresolved" }
  | { status: "amended"; target: Target; inputID: string; amendmentID: string; duplicate: boolean }

const origin = (value: unknown): Origin | undefined => {
  if (value === undefined) return undefined
  if (!value || typeof value !== "object" ||
    !("inputID" in value) || typeof value.inputID !== "string" || !("actorID" in value) || typeof value.actorID !== "string" ||
    !("fingerprint" in value) || typeof value.fingerprint !== "string") throw new Error("Invalid QQ origin metadata")
  const destination = target("target" in value ? value.target : "sessionID" in value ? value.sessionID : undefined)
  if ("target" in value && "sessionID" in value && !sameTarget(destination, target(value.sessionID))) throw new Error("Conflicting QQ origin target")
  if ("amendmentID" in value && (typeof value.amendmentID !== "string" || !/^msg_[A-Za-z0-9_-]+$/.test(value.amendmentID))) throw new Error("Invalid QQ amendment metadata")
  return { target: destination, inputID: value.inputID, actorID: value.actorID, fingerprint: value.fingerprint,
    ...("amendmentID" in value ? { amendmentID: value.amendmentID as string } : {}) }
}

/** Optional channel adapter. Native API remains the only execution and pending-input authority. No polling or task store. */
export function createPortal(options: { storage: Storage; session: Native; backend?: Backend; policy: Policy }) {
  const { storage, session, policy } = options
  const native = targets(session, options.backend)
  const key = (scope: Scope, id: string) => "origin:" + originKey(scope, id)
  const tombstone = (scope: Scope, id: string) => "recall:" + originKey(scope, id)
  const recalled = async (input: Message) => (await storage.get(tombstone(input.scope, input.messageID))) === input.actorID
  const lookup = async (scope: Scope, id: string) => origin(await storage.get(key(scope, id)))
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
    async linkReply(source: Message, outgoingMessageID: string) {
      const record = await lookup(source.scope, source.messageID)
      if (!record) throw new Error("QQ source message has no accepted origin")
      const inserted = await storage.insert(key(source.scope, outgoingMessageID), record)
      if (!inserted && JSON.stringify(await lookup(source.scope, outgoingMessageID)) !== JSON.stringify(record)) throw new Error("QQ reply origin conflict")
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
        ...(quoted ? { amendmentID: inputID(input) } : {}) }
      if (!(await storage.insert(key(input.scope, input.messageID), record))) {
        const winner = await lookup(input.scope, input.messageID)
        if (!winner) throw new Error("QQ origin admission was not retained")
        if (winner.fingerprint !== record.fingerprint) return { status: "conflict" }
        return result(winner, await evidence(winner), true)
      }
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
