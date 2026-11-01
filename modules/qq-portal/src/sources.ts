import { createHash } from "node:crypto"
import type { StorageDomain } from "../../../opencode/packages/plugin/src/promise/storage"
import { inputID, originKey, type Policy, type Scope } from "./routing"
import { target, sameTarget, type Target, type ParentInput } from "./target"

type Storage = Pick<StorageDomain, "get" | "insert">
export type Source = { scope: Scope; messageID: string; actorID: string }
export type Origin = { target: Target; inputID: string; actorID: string; fingerprint: string; amendmentID?: string; continuationID?: string; expectedTurnID?: string; followupOf?: ParentInput; source?: Source }
export type SourceResult = { status: "found"; source: Source } | { status: "missing" | "forbidden" | "uncertain" | "not-accepted" }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const account = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value)
const messageID = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value)
const controlledID = (value: unknown): value is string => typeof value === "string" && /^msg_[A-Za-z0-9_-]+$/.test(value)
const source = (value: unknown): Source => {
  if (!record(value) || !record(value.scope) || !account(value.scope.botID) ||
    value.scope.kind !== "private" && value.scope.kind !== "group" || !account(value.scope.peerID) ||
    !account(value.actorID) || !messageID(value.messageID) || value.actorID === value.scope.botID ||
    value.scope.kind === "private" && value.scope.peerID !== value.actorID)
    throw new Error("Invalid QQ source envelope")
  return { scope: { botID: value.scope.botID, kind: value.scope.kind as Scope["kind"], peerID: value.scope.peerID },
    messageID: value.messageID, actorID: value.actorID }
}
const sameSource = (left: Source, right: Source) => left.actorID === right.actorID &&
  originKey(left.scope, left.messageID) === originKey(right.scope, right.messageID)
const permitted = (value: Source, policy: Policy) => value.scope.botID === policy.botID &&
  policy.allowedUsers.includes(value.actorID) && (value.scope.kind === "private" || policy.allowedGroups.includes(value.scope.peerID))
export const sourceKey = (destination: Target, id: string) => "input-origin:" + createHash("sha256")
  .update(JSON.stringify(destination.kind === "session" ? ["session", destination.sessionID, id] : ["backend", destination.ref.backendID, destination.ref.threadID, id])).digest("hex")
const key = (scope: Scope, id: string) => "origin:" + originKey(scope, id)

/** Legacy records remain readable, but missing envelopes are never inferred from a current binding or reply alias. */
export const origin = (value: unknown): Origin | undefined => {
  if (value === undefined) return undefined
  if (!record(value) || !controlledID(value.inputID) || typeof value.actorID !== "string" || typeof value.fingerprint !== "string")
    throw new Error("Invalid QQ origin metadata")
  const destination = target("target" in value ? value.target : value.sessionID)
  if ("target" in value && "sessionID" in value && !sameTarget(destination, target(value.sessionID))) throw new Error("Conflicting QQ origin target")
  if ("amendmentID" in value && !controlledID(value.amendmentID)) throw new Error("Invalid QQ amendment metadata")
  if ("continuationID" in value && (!controlledID(value.continuationID) || "amendmentID" in value)) throw new Error("Invalid QQ continuation metadata")
  if ("expectedTurnID" in value && (destination.kind !== "backend" || !value.continuationID || typeof value.expectedTurnID !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.expectedTurnID))) throw new Error("Invalid native continuation fence")
  if (destination.kind === "backend" && value.continuationID && !value.expectedTurnID) throw new Error("Missing native continuation fence")
  let parent: ParentInput | undefined
  if ("followupOf" in value) {
    const p = value.followupOf
    if ("amendmentID" in value || "continuationID" in value || "expectedTurnID" in value || !record(p) || !controlledID(p.inputID) || p.inputID === value.inputID) throw new Error("Invalid native follow-up relation")
    if (destination.kind === "session") {
      if (!controlledID(p.rootID) || p.rootID === value.inputID || Object.keys(p).length !== 2) throw new Error("Invalid native Session parent")
      parent = { inputID: p.inputID, rootID: p.rootID }
    } else {
      const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v)
      if (!id(p.turnID) || !id(p.nativeID) || Object.keys(p).length !== 3) throw new Error("Invalid native backend parent")
      parent = { inputID: p.inputID, turnID: p.turnID, nativeID: p.nativeID }
    }
  }
  const envelope = "source" in value ? source(value.source) : undefined
  if (envelope && (envelope.actorID !== value.actorID || inputID(envelope) !== (value.continuationID ?? value.amendmentID ?? value.inputID)))
    throw new Error("Conflicting QQ source envelope")
  return { target: destination, inputID: value.inputID, actorID: value.actorID, fingerprint: value.fingerprint,
    ...(value.amendmentID ? { amendmentID: value.amendmentID as string } : {}), ...(value.continuationID ? { continuationID: value.continuationID as string } : {}), ...(value.expectedTurnID ? { expectedTurnID: value.expectedTurnID as string } : {}), ...(parent ? { followupOf: parent } : {}), ...(envelope ? { source: envelope } : {}) }
}

/** Only immutable routing metadata in the original plugin KV. No message bodies, execution state or delivery queue. */
export function sources(storage: Storage, policy: Policy) {
  const lookup = async (scope: Scope, id: string) => origin(await storage.get(key(scope, id)))
  const replyOrigin = async (entry: Source, outgoingMessageID: string) => {
    const identity = source(entry)
    if (!permitted(identity, policy) || !messageID(outgoingMessageID)) throw new Error("Invalid QQ reply identity")
    const value = await lookup(identity.scope, identity.messageID)
    if (!value?.source || !sameSource(value.source, identity)) throw new Error("QQ source envelope is unavailable")
    return value
  }
  return {
    lookup,
    replyOrigin,
    async retain(value: Origin) {
      if (!value.source || value.amendmentID || value.continuationID) return
      const entry = source(value.source)
      if (!permitted(entry, policy) || inputID(entry) !== value.inputID) throw new Error("Invalid QQ input source")
      const index = sourceKey(value.target, value.inputID)
      // Two public KV keys cannot share a transaction. Both must agree before handoff; a crash between writes never sends.
      // Redelivery may repair only this index from the already frozen envelope, then reconcile without resubmission.
      if (await storage.insert(index, entry)) return
      if (!sameSource(source(await storage.get(index)), entry)) throw new Error("QQ input source conflict")
    },
    async resolve(destination: Target, id: string): Promise<SourceResult> {
      if (!controlledID(id)) return { status: "missing" }
      const pointer = await storage.get(sourceKey(destination, id))
      if (pointer === undefined) return { status: "missing" }
      const entry = source(pointer)
      if (!permitted(entry, policy)) return { status: "forbidden" }
      const value = await lookup(entry.scope, entry.messageID)
      if (!value?.source || value.amendmentID || value.continuationID || value.inputID !== id || inputID(entry) !== id ||
        !sameTarget(value.target, destination) || !sameSource(value.source, entry)) throw new Error("QQ input source conflict")
      return { status: "found", source: entry }
    },
    async linkReply(entry: Source, outgoingMessageID: string) {
      const value = await replyOrigin(entry, outgoingMessageID)
      const inserted = await storage.insert(key(entry.scope, outgoingMessageID), value)
      if (!inserted && JSON.stringify(await lookup(entry.scope, outgoingMessageID)) !== JSON.stringify(value)) throw new Error("QQ reply origin conflict")
    },
  }
}
