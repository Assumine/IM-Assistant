import type { SessionApi, RpcClient } from "../../../opencode/packages/client/src/promise/api"
import type { ConversationBackend } from "../../../opencode/packages/schema/src/conversation-backend"
import { isConflictError } from "../../../opencode/packages/client/src/promise"

export type Target = { kind: "session"; sessionID: string } | { kind: "backend"; ref: ConversationBackend.Ref }
export type Native = Pick<SessionApi, "get" | "prompt" | "message"> & { inbox: Pick<SessionApi["inbox"], "list" | "cancel" | "update"> & Partial<Pick<SessionApi["inbox"], "append" | "amendment">> }
export type Backend = Pick<RpcClient<typeof ConversationBackend.Api>, "send" | "reconcile" | "execution" | "control" | "query">
export type Evidence = "accepted" | "uncertain" | "rejected" | "amended" | "conflict"
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
export function targets(session: Native, backend?: Backend) {
  const required = () => {
    if (!backend) throw new Error("Native conversation backend is unavailable")
    return backend
  }
  const receipt = (value: ConversationBackend.Admission, destination: Extract<Target, { kind: "backend" }>, inputID: string): Evidence => {
    if (value.inputID !== inputID || !sameTarget({ kind: "backend", ref: value.ref }, destination))
      throw new Error("Native QQ admission identity mismatch")
    return value.status
  }
  return {
    canAppend(destination: Target) { return destination.kind === "session" && !!session.inbox.append && !!session.inbox.amendment },
    async pending(destination: Target, inputID: string) {
      return destination.kind === "session" && (await session.inbox.list({ sessionID: destination.sessionID })).some((item) => item.id === inputID && item.type === "user")
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
      if ((await session.inbox.list({ sessionID: destination.sessionID })).some((entry) => entry.id === inputID)) return "accepted"
      return session.message.get({ sessionID: destination.sessionID, messageID: inputID })
        .then((entry) => entry.type === "user" ? "accepted" as const : "uncertain" as const, () => "uncertain" as const)
    },
    async send(destination: Target, inputID: string, text: string, metadata: Parameters<Native["prompt"]>[0]["metadata"]): Promise<Evidence> {
      if (destination.kind === "backend") return receipt(await required().send({ ref: destination.ref, inputID, text, delivery: "queue" }), destination, inputID)
      const accepted = await session.prompt({ sessionID: destination.sessionID, id: inputID, text, delivery: "queue", metadata })
      if (accepted.id !== inputID || accepted.sessionID !== destination.sessionID) throw new Error("Native QQ admission identity mismatch")
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
