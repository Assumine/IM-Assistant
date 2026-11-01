import type { StorageDomain } from "../../../opencode/packages/plugin/src/promise/storage"
import { fingerprint, inputID, originKey, type Message, type Scope } from "./routing"
import { origin, source, type Origin, type Source } from "./sources"
import { target, type Target } from "./target"
import type { HistoricalInput } from "./history"

type Storage = Pick<StorageDomain, "get" | "insert">
export type Choice = "approve" | "decline"
export type Proposal = { id: string; source: Source; fingerprint: string; from: Target; to: Target; parentInputID: string; historical?: HistoricalInput }
const key = (input: Source) => "confirmation:" + originKey(input.scope, input.messageID)
const decisionKey = (value: Proposal) => "confirmation-choice:" + originKey(value.source.scope, value.source.messageID)
const parse = (value: unknown): Proposal => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid QQ confirmation")
  const row = value as Record<string, unknown>
  const to = target(row.to), from = target(row.from)
  const identity = origin({ target: to, inputID: row.id, actorID: row.actorID, fingerprint: row.fingerprint, source: row.source, historical: row.historical })
  if (!identity?.source || typeof row.parentInputID !== "string" || !/^msg_[A-Za-z0-9_-]+$/.test(row.parentInputID) ||
    !/^[0-9a-f]{64}$/.test(identity.fingerprint)) throw new Error("Invalid QQ confirmation identity")
  return { id: identity.inputID, source: identity.source, fingerprint: identity.fingerprint, from, to, parentInputID: row.parentInputID, ...(identity.historical ? { historical: identity.historical } : {}) }
}

/** Consent and immutable routing metadata only. No body, execution status, retries or pending-work queue. */
export function confirmations(storage: Storage) {
  const get = async (input: Source) => {
    const value = await storage.get(key(input))
    if (value === undefined) return undefined
    const proposal = parse(value)
    if (proposal.id !== inputID(input) || proposal.source.actorID !== input.actorID ||
      originKey(proposal.source.scope, proposal.source.messageID) !== originKey(input.scope, input.messageID))
      throw new Error("QQ confirmation source conflict")
    return proposal
  }
  const read = async (input: Message) => {
    const proposal = await get(input)
    if (proposal && proposal.fingerprint !== fingerprint(input)) throw new Error("QQ confirmation content conflict")
    return proposal
  }
  const choice = async (proposal: Proposal): Promise<Choice | undefined> => {
    const value = await storage.get(decisionKey(proposal))
    if (value === undefined || value === "approve" || value === "decline") return value
    throw new Error("Invalid QQ confirmation choice")
  }
  return {
    read, choice,
    async publish(input: Message, outgoingID: string) {
      if (!/^-?(?:0|[1-9][0-9]{0,19})$/.test(outgoingID) || !Number.isSafeInteger(Number(outgoingID))) throw new Error("Invalid confirmation prompt ID")
      const proposal = await read(input)
      if (!proposal) throw new Error("QQ confirmation is missing")
      const alias = "confirmation-prompt:" + originKey(input.scope, outgoingID)
      const value = { source: proposal.source, id: proposal.id, fingerprint: proposal.fingerprint }
      if (!await storage.insert(alias, value) && JSON.stringify(await storage.get(alias)) !== JSON.stringify(value)) throw new Error("Conflicting QQ confirmation prompt")
    },
    async prompt(scope: Scope, outgoingID: string, actorID: string) {
      const value = await storage.get("confirmation-prompt:" + originKey(scope, outgoingID))
      if (value === undefined) return undefined
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid confirmation prompt")
      const row = value as Record<string, unknown>
      const identity = source(row.source)
      if (identity.actorID !== actorID || originKey(identity.scope, outgoingID) !== originKey(scope, outgoingID)) return undefined
      const proposal = await get(identity)
      if (!proposal || proposal.id !== row.id || proposal.fingerprint !== row.fingerprint) throw new Error("Unproven confirmation prompt")
      return proposal
    },
    async propose(input: Message, from: Target, quoted: Origin, historical?: HistoricalInput) {
      const value = { id: inputID(input), source: { scope: input.scope, messageID: input.messageID, actorID: input.actorID },
        actorID: input.actorID, fingerprint: fingerprint(input), from, to: quoted.target, parentInputID: quoted.inputID, ...(historical ? { historical } : {}) }
      const created = await storage.insert(key(input), value)
      const proposal = await read(input)
      if (!proposal) throw new Error("QQ confirmation was not retained")
      return { proposal, created }
    },
    async decide(proposal: Proposal, value: Choice) {
      await storage.insert(decisionKey(proposal), value)
      const selected = await choice(proposal)
      if (!selected) throw new Error("QQ confirmation choice was not retained")
      return selected
    },
  }
}
