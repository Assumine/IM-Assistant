import type { SessionApi, RpcClient } from "../../../opencode/packages/client/src/promise/api"
import type { ConversationBackend } from "../../../opencode/packages/schema/src/conversation-backend"
import { isConflictError } from "../../../opencode/packages/client/src/promise"
import type { PromptInput } from "../../../opencode/packages/schema/src/prompt-input"

export type Target = { kind: "session"; sessionID: string } | { kind: "backend"; ref: ConversationBackend.Ref }
export type Withdrawal = { target: Target; inputID: string; nativeID: string }
export type Native = Pick<SessionApi, "get" | "prompt" | "message"> & Partial<Pick<SessionApi, "list">> & { inbox: Pick<SessionApi["inbox"], "list" | "cancel" | "update"> & Partial<Pick<SessionApi["inbox"], "append" | "amendment">>; input?: Pick<SessionApi["input"], "continue" | "continuation"> & Partial<Pick<SessionApi["input"], "position" | "followup" | "followupReceipt">> }
export type Backend = Pick<RpcClient<typeof ConversationBackend.Api>, "send" | "reconcile" | "execution" | "control" | "query"> & Partial<Pick<RpcClient<typeof ConversationBackend.Api>, "input" | "threads" | "list">>
export type Evidence = "accepted" | "uncertain" | "rejected" | "amended" | "conflict" | "continuation-accepted" | "continuation-pending" | "continuation-delivered" | "continuation-expired" | "continuation-cancelled" | "followup-accepted" | "followup-pending" | "followup-delivered" | "followup-cancelled"
type SessionParentInput = { inputID: string; rootID: string }
export type ParentInput = SessionParentInput | ConversationBackend.ParentInput
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)

/** Legacy scalar bindings are read as ordinary Sessions; no migration writes or native thread aliases. */
export function target(value: unknown): Target {
  if (id(value)) return { kind: "session", sessionID: value }
  if (record(value) && value.kind === "session" && id(value.sessionID) && Object.keys(value).length === 2)
    return { kind: "session", sessionID: value.sessionID }
  if (record(value) && value.kind === "backend" && Object.keys(value).length === 2 && record(value.ref) &&
    Object.keys(value.ref).length === 2 && id(value.ref.backendID) && value.ref.backendID !== "opencode" && id(value.ref.threadID))
    return { kind: "backend", ref: { backendID: value.ref.backendID, threadID: value.ref.threadID } }
  throw new Error("Invalid QQ conversation target")
}
export const sameTarget = (left: Target, right: Target) => left.kind === "session" && right.kind === "session"
  ? left.sessionID === right.sessionID
  : left.kind === "backend" && right.kind === "backend" && left.ref.backendID === right.ref.backendID && left.ref.threadID === right.ref.threadID

/** Only public native APIs. This adapter does not own execution, pending work or a backend connection. */
export function targets(session: Native, backend?: Backend, onWithdrawal?: (value: Withdrawal) => Promise<void>) {
  const required = () => {
    if (!backend) throw new Error("Native conversation backend is unavailable")
    return backend
  }
  const receipt = (value: ConversationBackend.Admission, destination: Extract<Target, { kind: "backend" }>, inputID: string): Evidence => {
    if (value.inputID !== inputID || !sameTarget({ kind: "backend", ref: value.ref }, destination))
      throw new Error("Native QQ admission identity mismatch")
    return value.status
  }
  const continued = (value: Awaited<ReturnType<SessionApi["input"]["continuation"]>>, destination: Extract<Target, { kind: "session" }>, inputID: string, continuationID: string): Evidence => {
    if (value.sessionID !== destination.sessionID || value.expectedInputID !== inputID || value.inboxID !== continuationID || value.status !== "unknown" && !value.rootID)
      throw new Error("Wrong native continuation receipt")
    return value.status === "unknown" ? "uncertain" : `continuation-${value.status}`
  }
  const position = async (destination: Extract<Target, { kind: "backend" }>, inputID: string) => {
    const read = required().input
    if (!read) throw new Error("Native input identity is unavailable")
    const value = await read({ ref: destination.ref, inputID })
    if (value.inputID !== inputID || !sameTarget({ kind: "backend", ref: value.ref }, destination)) throw new Error("Wrong native input identity")
    return value
  }
  const guided = async (value: ConversationBackend.Admission, destination: Extract<Target, { kind: "backend" }>, continuationID: string, expectedTurnID: string): Promise<Evidence> => {
    const state = receipt(value, destination, continuationID)
    if (state !== "accepted") return state === "rejected" ? "conflict" : state
    if (value.status !== "accepted") return "uncertain"
    if (value.receipt.kind === "steered") return value.receipt.nativeID === expectedTurnID ? "continuation-accepted" : "uncertain"
    if (value.receipt.kind !== "message") return "uncertain"
    const found = await position(destination, continuationID)
    return (found.status === "delivered" || found.status === "closed") && found.turnID === expectedTurnID && found.nativeID === value.receipt.nativeID ? "continuation-delivered" : "uncertain"
  }
  const followed = (value: Awaited<ReturnType<SessionApi["input"]["followupReceipt"]>>, destination: Extract<Target, { kind: "session" }>, inputID: string, parent: SessionParentInput): Evidence => {
    if (value.sessionID !== destination.sessionID || value.inboxID !== inputID || value.expectedInputID !== parent.inputID ||
      value.status !== "unknown" && value.rootID !== parent.rootID) throw new Error("Wrong native follow-up receipt")
    return value.status === "unknown" ? "uncertain" : `followup-${value.status}`
  }
  const backendFollowed = (value: ConversationBackend.Admission, destination: Extract<Target, { kind: "backend" }>, inputID: string, parent: ConversationBackend.ParentInput): Evidence => {
    const state = receipt(value, destination, inputID)
    if (state !== "accepted") return state === "rejected" ? "conflict" : state
    if (value.status !== "accepted" || !value.followupOf || value.followupOf.inputID !== parent.inputID || value.followupOf.turnID !== parent.turnID || value.followupOf.nativeID !== parent.nativeID) return "uncertain"
    return value.receipt.kind === "queued" ? "followup-accepted" : value.receipt.kind === "message" ? "followup-delivered" : "uncertain"
  }
  return {
    async canFiles(destination: Target) { return destination.kind === "session" || !!(await backend?.list?.({}))?.find((item) => item.id === destination.ref.backendID)?.images },
    canAppend(destination: Target) { return destination.kind === "session" && !!session.inbox.append && !!session.inbox.amendment },
    canContinue(destination: Target) { return destination.kind === "session" ? !!session.input?.continue && !!session.input?.continuation : !!backend?.input },
    canFollowup(destination: Target) { return destination.kind === "session" ? !!session.input?.position && !!session.input?.followup && !!session.input?.followupReceipt : !!backend?.input },
    async followup(destination: Target, inputID: string, parent: ParentInput, text: string, metadata: Parameters<Native["prompt"]>[0]["metadata"], files?: readonly PromptInput.FileAttachment[]): Promise<Evidence> {
      if (destination.kind === "backend") return "turnID" in parent ? backendFollowed(await required().send({ ref: destination.ref, inputID, text, delivery: "queue", followupOf: parent, ...(files?.length ? { files } : {}) }), destination, inputID, parent) : "uncertain"
      if (files?.length) return "conflict"
      if (!("rootID" in parent) || !session.input?.followup) return "uncertain"
      try { return followed(await session.input.followup({ sessionID: destination.sessionID, inboxID: inputID, expectedInputID: parent.inputID, expectedRootID: parent.rootID, text, metadata }), destination, inputID, parent) }
      catch (error) { if (isConflictError(error)) return "conflict"; throw error }
    },
    async followupReceipt(destination: Target, inputID: string, parent: ParentInput): Promise<Evidence> {
      if (destination.kind === "backend") return "turnID" in parent ? backendFollowed(await required().reconcile({ ref: destination.ref, inputID }), destination, inputID, parent) : "uncertain"
      if (!("rootID" in parent) || !session.input?.followupReceipt) return "uncertain"
      return followed(await session.input.followupReceipt({ sessionID: destination.sessionID, inboxID: inputID, expectedInputID: parent.inputID }), destination, inputID, parent)
    },
    async continueInput(destination: Target, inputID: string, continuationID: string, text: string, metadata: Parameters<Native["prompt"]>[0]["metadata"], expectedTurnID?: string, files?: readonly PromptInput.FileAttachment[]): Promise<Evidence> {
      if (destination.kind === "backend") {
        if (!expectedTurnID) return "uncertain"
        return guided(await required().send({ ref: destination.ref, inputID: continuationID, text, delivery: "steer", expectedTurnID, ...(files?.length ? { files } : {}) }), destination, continuationID, expectedTurnID)
      }
      if (files?.length) return "conflict"
      if (destination.kind !== "session" || !session.input) return "uncertain"
      try { return continued(await session.input.continue({ sessionID: destination.sessionID, expectedInputID: inputID, inboxID: continuationID, text, metadata }), destination, inputID, continuationID) }
      catch (error) { if (isConflictError(error)) return "conflict"; throw error }
    },
    async continuation(destination: Target, inputID: string, continuationID: string, expectedTurnID?: string): Promise<Evidence> {
      if (destination.kind === "backend") {
        if (!expectedTurnID) return "uncertain"
        return guided(await required().reconcile({ ref: destination.ref, inputID: continuationID }), destination, continuationID, expectedTurnID)
      }
      if (destination.kind !== "session" || !session.input) return "uncertain"
      return continued(await session.input.continuation({ sessionID: destination.sessionID, expectedInputID: inputID, inboxID: continuationID }), destination, inputID, continuationID)
    },
    async quote(destination: Target, inputID: string): Promise<{ status: "pending" | "delivered" | "closed" | "unknown"; expectedTurnID?: string; parent?: ParentInput }> {
      if (destination.kind === "session" && session.input?.position) {
        const state = await session.input.position({ sessionID: destination.sessionID, inputID })
        if (state.sessionID !== destination.sessionID || state.inputID !== inputID || (state.status === "open" || state.status === "closed") && !state.rootID) throw new Error("Wrong native input position")
        return { status: state.status === "open" ? "delivered" : state.status, ...(state.status === "closed" && state.rootID ? { parent: { inputID, rootID: state.rootID } } : {}) }
      }
      if (destination.kind === "session") return { status: (await session.inbox.list({ sessionID: destination.sessionID })).some((item) => item.id === inputID && item.type === "user") ? "pending" : "delivered" }
      const found = await position(destination, inputID)
      if (found.status === "closed") return { status: "closed", parent: { inputID, turnID: found.turnID, nativeID: found.nativeID } }
      return found.status === "queued" ? { status: "pending" } : found.status === "delivered" ? { status: "delivered", expectedTurnID: found.turnID } : { status: "unknown" }
    },
    async append(destination: Target, inputID: string, amendmentID: string, text: string): Promise<Evidence> {
      if (destination.kind !== "session" || !session.inbox.append) return "uncertain"
      try {
        const receipt = await session.inbox.append({ sessionID: destination.sessionID, inboxID: inputID, amendmentID, text })
        if (receipt.sessionID !== destination.sessionID || receipt.inboxID !== inputID || receipt.amendmentID !== amendmentID) throw new Error("Wrong native amendment receipt")
        return receipt.status === "applied" ? "amended" : "uncertain"
      } catch (error) { if (isConflictError(error)) return "conflict"; throw error }
    },
    async amendment(destination: Target, inputID: string, amendmentID: string): Promise<Evidence> {
      if (destination.kind !== "session" || !session.inbox.amendment) return "uncertain"
      const receipt = await session.inbox.amendment({ sessionID: destination.sessionID, inboxID: inputID, amendmentID })
      if (receipt.sessionID !== destination.sessionID || receipt.inboxID !== inputID || receipt.amendmentID !== amendmentID) throw new Error("Wrong native amendment receipt")
      return receipt.status === "applied" ? "amended" : "uncertain"
    },
    async validate(destination: Target) {
      if (destination.kind === "session") {
        if ((await session.get({ sessionID: destination.sessionID })).id !== destination.sessionID) throw new Error("Wrong native Session")
      } else {
        // A newly created native thread has no turns yet. Binding reads ownership, never execution or resume.
        const snapshot = await required().query({ backendID: destination.ref.backendID,
          query: { action: "read", threadID: destination.ref.threadID } })
        if (!record(snapshot) || !record(snapshot.thread) || snapshot.thread.id !== destination.ref.threadID)
          throw new Error("Wrong native conversation")
      }
    },
    async reconcile(destination: Target, inputID: string): Promise<Evidence> {
      if (destination.kind === "backend") return receipt(await required().reconcile({ ref: destination.ref, inputID }), destination, inputID)
      if ((await session.inbox.list({ sessionID: destination.sessionID })).some((entry) => entry.id === inputID && entry.type === "user")) return "accepted"
      return session.message.get({ sessionID: destination.sessionID, messageID: inputID })
        .then((entry) => entry.type === "user" ? "accepted" as const : "uncertain" as const, () => "uncertain" as const)
    },
    async send(destination: Target, inputID: string, text: string, metadata: Parameters<Native["prompt"]>[0]["metadata"], files?: readonly PromptInput.FileAttachment[]): Promise<Evidence> {
      if (destination.kind === "backend") return receipt(await required().send({ ref: destination.ref, inputID, text, delivery: "queue", ...(files?.length ? { files } : {}) }), destination, inputID)
      const accepted = await session.prompt({ sessionID: destination.sessionID, id: inputID, text, delivery: "queue", metadata, ...(files?.length ? { files } : {}) })
      if (accepted.id !== inputID || accepted.sessionID !== destination.sessionID || accepted.type !== "user") throw new Error("Native QQ admission identity mismatch")
      return "accepted"
    },
    async withdraw(destination: Target, inputID: string): Promise<"withdrawn" | "unchanged" | "uncertain"> {
      if (destination.kind === "session") {
        if (!(await session.inbox.list({ sessionID: destination.sessionID })).some((entry) => entry.id === inputID)) return "unchanged"
        await session.inbox.cancel({ sessionID: destination.sessionID, inboxID: inputID })
        return "withdrawn"
      }
      const api = required()
      const seen = new Set<string>()
      let cursor: string | undefined
      do {
        const snapshot = await api.execution({ ref: destination.ref, cursor, limit: 100 })
        if (!sameTarget({ kind: "backend", ref: snapshot.thread.ref }, destination)) throw new Error("Wrong native conversation")
        const pending = snapshot.queue.filter((entry) => entry.inputID === inputID)
        if (pending.length > 1) return "uncertain"
        if (pending[0]) {
          const result = await api.control({ backendID: destination.ref.backendID,
            control: { action: "withdraw", threadID: destination.ref.threadID, nativeID: pending[0].nativeID } })
          if (result.status === "applied") await onWithdrawal?.({ target: destination, inputID, nativeID: pending[0].nativeID })
          return result.status === "applied" ? "withdrawn" : result.status === "not-found" ? "unchanged" : "uncertain"
        }
        cursor = snapshot.nextCursor
        if (cursor && seen.has(cursor)) throw new Error("Repeated native queue cursor")
        if (cursor) seen.add(cursor)
      } while (cursor)
      return "unchanged"
    },
  }
}
