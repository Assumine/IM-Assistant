import type { StorageDomain } from "../../../opencode/packages/plugin/src/promise/storage"
import type { Source } from "./sources"
import type { SendResult } from "./onebot"
import type { NotificationReceipt } from "./notifications"

/** Shared receipt handling. Callers authorize the source and atomically freeze their own immutable intent first. */
export function delivery(options: {
  storage: Pick<StorageDomain, "get" | "insert">
  send: (source: Source, text: string) => Promise<SendResult | { status: "forbidden" }>
}) {
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
  const read = async (key: string, hash: string): Promise<NotificationReceipt> => {
    const receipt = await options.storage.get(key)
    if (!record(receipt) || receipt.version !== 1 || receipt.hash !== hash) return { status: "uncertain" }
    if (receipt.status === "sent") return typeof receipt.messageID === "string" && /^-?(?:0|[1-9][0-9]{0,19})$/.test(receipt.messageID) && Number.isSafeInteger(Number(receipt.messageID))
      ? { status: "sent", messageID: receipt.messageID, linkage: "not-checked", duplicate: true } : { status: "uncertain" }
    return receipt.status === "unavailable" || receipt.status === "rejected" || receipt.status === "uncertain" || receipt.status === "forbidden" ? { status: receipt.status, duplicate: true } : { status: "uncertain" }
  }
  const finish = async (key: string, hash: string, duplicate: boolean, publish?: (messageID: string) => Promise<void>): Promise<NotificationReceipt> => {
    const receipt = await read(key, hash)
    if (receipt.status !== "sent") return { ...receipt, duplicate }
    if (!publish) return { ...receipt, duplicate, linkage: "not-required" }
    try { await publish(receipt.messageID); return { ...receipt, duplicate, linkage: "linked" } }
    catch { return { ...receipt, duplicate, linkage: "unlinked" } }
  }
  return {
    read, finish,
    /** Only the caller that won durable intent insertion may invoke this once. Unknown never authorizes replay. */
    async attempt(key: string, hash: string, source: Source, text: string, publish?: (messageID: string) => Promise<void>) {
      let sent: SendResult | { status: "forbidden" }
      try { sent = await options.send(source, text) } catch { sent = { status: "uncertain" } }
      try { await options.storage.insert(key, { version: 1, hash, ...sent }) } catch { /* Reconcile only; never repeat wire effects. */ }
      return finish(key, hash, false, publish)
    },
  }
}
