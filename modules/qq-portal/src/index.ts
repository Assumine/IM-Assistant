import type { StorageDomain } from "../../../opencode/packages/plugin/src/promise/storage"
import { command, decode, fingerprint, inputID, originKey, scopeKey, type Message, type Policy, type Scope } from "./routing"
import { target, sameTarget, targets, type Target, type Native, type Backend, type Evidence } from "./target"
import { sources, type Origin, type Source, type SourceResult } from "./sources"
import { confirmations, type Choice, type Proposal } from "./confirmation"

type Storage = Pick<StorageDomain, "get" | "set" | "insert">
export type Result =
  | { status: "ignored" | "unsupported" | "unbound" | "recalled" | "uncertain" | "unchanged" | "withdrawn" | "conflict" }
  | { status: "command"; action: string; arguments: string }
  | { status: "blocked"; reason: "quoted-adjustment-unavailable" | "quoted-task-not-pending" | "quoted-task-not-active" | "quoted-adjustment-expired" | "quoted-adjustment-cancelled" }
  | { status: "rejected"; reason: "not-accepted" }
  | { status: "accepted"; target: Target; sessionID?: string; inputID: string; duplicate: boolean; reference?: "unresolved" }
  | { status: "amended"; target: Target; inputID: string; amendmentID: string; duplicate: boolean }
  | { status: "steered"; target: Target; inputID: string; continuationID: string; delivery: "accepted" | "pending" | "delivered"; duplicate: boolean }
  | { status: "confirmation-required"; confirmationID: string; target: Target; duplicate: boolean }
  | { status: "confirmation-declined" }

/** Optional channel adapter. Native API remains the only execution and pending-input authority. No polling or task store. */
export function createPortal(options: { storage: Storage; session: Native; backend?: Backend; policy: Policy }) {
  const { storage, session, policy } = options
  const native = targets(session, options.backend)
  const metadata = sources(storage, policy)
  const consent = confirmations(storage)
  const confirmationResult = (proposal: Proposal, duplicate: boolean): Result => ({ status: "confirmation-required", confirmationID: proposal.id, target: proposal.to, duplicate })
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
    : (evidence === "continuation-accepted" || evidence === "continuation-pending" || evidence === "continuation-delivered") && record.continuationID
      ? { status: "steered", target: record.target, inputID: record.inputID, continuationID: record.continuationID, delivery: evidence === "continuation-accepted" ? "accepted" : evidence === "continuation-pending" ? "pending" : "delivered", duplicate }
    : evidence === "continuation-expired" ? { status: "blocked", reason: "quoted-adjustment-expired" }
    : evidence === "continuation-cancelled" ? { status: "blocked", reason: "quoted-adjustment-cancelled" }
    : evidence === "conflict" ? { status: "blocked", reason: record.continuationID ? "quoted-task-not-active" : "quoted-task-not-pending" } : evidence === "accepted" ? accepted(record, duplicate)
    : evidence === "rejected" ? { status: "rejected", reason: "not-accepted" } : { status: "uncertain" }
  const evidence = async (record: Origin): Promise<Evidence> => {
    try { return record.continuationID ? await native.continuation(record.target, record.inputID, record.continuationID, record.expectedTurnID) : record.amendmentID ? await native.amendment(record.target, record.inputID, record.amendmentID) : await native.reconcile(record.target, record.inputID) }
    catch { return "uncertain" }
  }
  const withdraw = async (record: Origin): Promise<Result> => {
    try { return { status: await native.withdraw(record.target, record.inputID) } }
    catch { return { status: "uncertain" } }
  }
  const receive = async (raw: unknown): Promise<Result> => {
    const event = decode(raw, policy)
    if (event.kind === "ignored" || event.kind === "unsupported") return { status: event.kind }
    if (event.kind === "recall") {
      const input = event.recall
      const record = await lookup(input.scope, input.messageID)
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
    let proposal: Proposal | undefined
    try { proposal = await consent.read(input) } catch { return { status: "conflict" } }
    if (proposal) {
      const choice = await consent.choice(proposal)
      if (!choice) return confirmationResult(proposal, true)
      if (choice === "decline") return { status: "confirmation-declined" }
    }
    const destination = proposal?.to ?? await binding(input.scope)
    if (!destination) return { status: "unbound" }
    const quoted = input.quoteID ? await lookup(input.scope, input.quoteID) : undefined
    if (proposal && (!quoted || !sameTarget(quoted.target, proposal.to) || quoted.inputID !== proposal.parentInputID)) return { status: "conflict" }
    let adjustment: "amendmentID" | "continuationID" | undefined
    let expectedTurnID: string | undefined
    if (quoted) {
      if (!sameTarget(quoted.target, destination)) {
        const { proposal, created } = await consent.propose(input, destination, quoted)
        return confirmationResult(proposal, !created)
      }
      if (!native.canAppend(destination) && !native.canContinue(destination)) return { status: "blocked", reason: "quoted-adjustment-unavailable" }
      try {
        const found = await native.quote(destination, quoted.inputID)
        if (found.status === "unknown") return { status: "uncertain" }
        if (found.status === "pending" && native.canAppend(destination)) adjustment = "amendmentID"
        else if (found.status === "delivered" && native.canContinue(destination)) { adjustment = "continuationID"; expectedTurnID = found.expectedTurnID }
        else return { status: "blocked", reason: "quoted-task-not-pending" }
      }
      catch { return { status: "uncertain" } }
    }
    const record: Origin = { target: destination, inputID: quoted?.inputID ?? inputID(input), actorID: input.actorID, fingerprint: fingerprint(input),
      source: { scope: input.scope, messageID: input.messageID, actorID: input.actorID },
      ...(expectedTurnID ? { expectedTurnID } : {}),
      ...(adjustment ? { [adjustment]: inputID(input) } : {}) }
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
      const metadata = { qq: { botID: input.scope.botID, kind: input.scope.kind, peerID: input.scope.peerID, actorID: input.actorID, messageID: input.messageID, ...(input.quoteID ? { quoteID: input.quoteID } : {}), mentions: input.mentions } }
      const state = record.continuationID ? await native.continueInput(record.target, record.inputID, record.continuationID, input.text, metadata, record.expectedTurnID)
        : record.amendmentID ? await native.append(record.target, record.inputID, record.amendmentID, input.text) : await native.send(record.target, record.inputID, input.text, metadata)
      if (state !== "accepted") return result(record, state, false)
    } catch { return result(record, await evidence(record), true) }
    if (await recalled(input)) return withdraw(record)
    return { ...accepted(record, false), ...(input.quoteID ? { reference: "unresolved" as const } : {}) }
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
      if (state !== "accepted" && state !== "amended" && state !== "continuation-accepted" && state !== "continuation-pending" && state !== "continuation-delivered") throw new Error("QQ source input is not confirmed accepted")
      await metadata.linkReply(source, outgoingMessageID)
    },
    /** Trusted transport calls this only after explicit user consent, with the original message fetched by ID. */
    async confirm(raw: unknown, approval: { confirmationID: string; scope: Scope; actorID: string; choice: Choice }): Promise<Result> {
      const event = decode(raw, policy)
      if (event.kind === "ignored" || event.kind === "unsupported") return { status: event.kind }
      if (event.kind !== "message") return { status: "unsupported" }
      const input = event.message
      if (approval.actorID !== input.actorID || scopeKey(approval.scope) !== scopeKey(input.scope)) return { status: "ignored" }
      if (approval.choice !== "approve" && approval.choice !== "decline") return { status: "unsupported" }
      if (await recalled(input)) return { status: "recalled" }
      let proposal: Proposal | undefined
      try { proposal = await consent.read(input) } catch { return { status: "conflict" } }
      if (!proposal || proposal.id !== approval.confirmationID) return { status: "conflict" }
      if (await consent.decide(proposal, approval.choice) === "decline") return { status: "confirmation-declined" }
      return receive(raw)
    },
    receive,
  }
}

export { decode, command, type Message, type Policy, type Scope } from "./routing"
export { type Target, type Backend } from "./target"
export { type Source, type SourceResult } from "./sources"
