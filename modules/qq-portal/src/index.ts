import type { SessionApi } from "../../../opencode/packages/client/src/promise/api"
import type { StorageDomain } from "../../../opencode/packages/plugin/src/promise/storage"
import { command, decode, fingerprint, inputID, originKey, scopeKey, type Message, type Policy, type Scope } from "./routing"

type Storage = Pick<StorageDomain, "get" | "set" | "insert">
type Native = Pick<SessionApi, "get" | "prompt" | "inbox" | "message">
type Origin = { sessionID: string; inputID: string; actorID: string; fingerprint: string }
export type Result =
  | { status: "ignored" | "unsupported" | "unbound" | "recalled" | "uncertain" | "unchanged" | "withdrawn" | "conflict" }
  | { status: "command"; action: string; arguments: string }
  | { status: "blocked"; reason: "cross-session-confirmation-required" | "quoted-adjustment-unavailable" }
  | { status: "accepted"; sessionID: string; inputID: string; duplicate: boolean; reference?: "unresolved" }

const origin = (value: unknown): Origin | undefined => {
  if (value === undefined) return undefined
  if (!value || typeof value !== "object" || !("sessionID" in value) || typeof value.sessionID !== "string" ||
    !("inputID" in value) || typeof value.inputID !== "string" || !("actorID" in value) || typeof value.actorID !== "string" ||
    !("fingerprint" in value) || typeof value.fingerprint !== "string") throw new Error("Invalid QQ origin metadata")
  return value as Origin
}

/** Optional channel adapter. Native API remains the only execution and pending-input authority. No polling or task store. */
export function createPortal(options: { storage: Storage; session: Native; policy: Policy }) {
  const { storage, session, policy } = options
  const key = (scope: Scope, id: string) => "origin:" + originKey(scope, id)
  const tombstone = (scope: Scope, id: string) => "recall:" + originKey(scope, id)
  const recalled = async (input: Message) => (await storage.get(tombstone(input.scope, input.messageID))) === input.actorID
  const lookup = async (scope: Scope, id: string) => origin(await storage.get(key(scope, id)))
  const binding = async (scope: Scope) => {
    const value = await storage.get("binding:" + scopeKey(scope))
    if (value === undefined || value === null) return undefined
    if (typeof value !== "string") throw new Error("Invalid QQ binding metadata")
    return value
  }
  const accepted = (record: Origin, duplicate: boolean): Result => ({ status: "accepted", sessionID: record.sessionID, inputID: record.inputID, duplicate })
  const evidence = async (record: Origin) => {
    if ((await session.inbox.list({ sessionID: record.sessionID })).some((entry) => entry.id === record.inputID)) return true
    // A failed read is unknown, never evidence that the model did not receive the input.
    return session.message.get({ sessionID: record.sessionID, messageID: record.inputID }).then((entry) => entry.type === "user", () => false)
  }
  const withdraw = async (record: Origin): Promise<Result> => {
    if (!(await session.inbox.list({ sessionID: record.sessionID })).some((entry) => entry.id === record.inputID)) return { status: "unchanged" }
    try {
      await session.inbox.cancel({ sessionID: record.sessionID, inboxID: record.inputID })
      return { status: "withdrawn" }
    } catch { return { status: "uncertain" } }
  }
  return {
    /** Trusted host control API; remote transports must authorize controls before calling it. */
    async bind(scope: Scope, sessionID?: string) {
      if (scope.botID !== policy.botID) throw new Error("Wrong QQ bot")
      if (sessionID) await session.get({ sessionID })
      await storage.set("binding:" + scopeKey(scope), sessionID ?? null)
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
        if (record && record.actorID !== input.actorID) return { status: "unchanged" }
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
        return await evidence(old) ? accepted(old, true) : { status: "uncertain" }
      }
      const target = await binding(input.scope)
      if (!target) return { status: "unbound" }
      const quoted = input.quoteID ? await lookup(input.scope, input.quoteID) : undefined
      if (quoted) return { status: "blocked", reason: quoted.sessionID !== target ? "cross-session-confirmation-required" : "quoted-adjustment-unavailable" }
      const record: Origin = { sessionID: target, inputID: inputID(input), actorID: input.actorID, fingerprint: fingerprint(input) }
      if (!(await storage.insert(key(input.scope, input.messageID), record))) {
        const winner = await lookup(input.scope, input.messageID)
        if (!winner) throw new Error("QQ origin admission was not retained")
        if (winner.fingerprint !== record.fingerprint) return { status: "conflict" }
        return await evidence(winner) ? accepted(winner, true) : { status: "uncertain" }
      }
      if (await recalled(input)) return { status: "recalled" }
      try {
        const receipt = await session.prompt({ sessionID: record.sessionID, id: record.inputID, text: input.text, delivery: "queue",
          metadata: { qq: { botID: input.scope.botID, kind: input.scope.kind, peerID: input.scope.peerID, actorID: input.actorID, messageID: input.messageID, ...(input.quoteID ? { quoteID: input.quoteID } : {}), mentions: input.mentions } } })
        if (receipt.id !== record.inputID || receipt.sessionID !== record.sessionID) throw new Error("Native QQ admission identity mismatch")
      } catch { return await evidence(record) ? accepted(record, true) : { status: "uncertain" } }
      if (await recalled(input)) return withdraw(record)
      return { ...accepted(record, false), ...(input.quoteID ? { reference: "unresolved" as const } : {}) }
    },
  }
}

export { decode, command, type Message, type Policy, type Scope } from "./routing"
