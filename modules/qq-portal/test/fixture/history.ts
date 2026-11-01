import type { StorageDomain } from "../../../../opencode/packages/plugin/src/promise/storage"

export function historyStorage() {
  type Value = Parameters<StorageDomain["set"]>[1]
  const values = new Map<string, Value>()
  return {
    values,
    storage: {
      get: async (key: string) => values.get(key),
      set: async (key: string, value: Value) => { values.set(key, structuredClone(value)) },
      insert: async (key: string, value: Value) => { if (values.has(key)) return false; values.set(key, structuredClone(value)); return true },
      remove: async (key: string) => { values.delete(key) },
      scan: async ({ prefix, after, limit }: { prefix: string; after?: string; limit?: number }) => {
        const keys = [...values.keys()].filter((key) => key.startsWith(prefix) && (!after || key > after)).sort()
        const selected = keys.slice(0, limit ?? 100)
        return { entries: selected.map((key) => ({ key, value: values.get(key)! })), ...(keys.length > selected.length ? { next: selected.at(-1)! } : {}) }
      },
    },
  }
}

export function historyEvent(messageID: number, sequence: string, text = "Body " + messageID, actorID = "20001", groupID?: string) {
  const message: { type: string; data: Record<string, string> }[] = [...(groupID ? [{ type: "at", data: { qq: "10001" } }] : []), { type: "text", data: { text } }]
  return { post_type: "message", self_id: "10001", message_type: groupID ? "group" : "private", message_id: messageID,
    user_id: actorID, ...(groupID ? { group_id: groupID } : {}), real_seq: sequence,
    time: 1700000000 + Number(BigInt(sequence) % 1000000n),
    message,
  }
}
