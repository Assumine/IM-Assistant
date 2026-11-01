import { accountID, record } from "./policy"

export type ChatPacket = { text?: string; mentions?: string[]; sticker?: string }
export type Sticker = { id: string; label: string; uri: string }
export const replyProtocol = `QQ response protocol: Return only a JSON object {"messages":[{"text":"short reply","mentions":["member ID"],"sticker":"approved sticker ID"}]}. No Markdown fence. messages may be empty when you should not participate. Do not answer every group message: consider whether it addresses you or adds something you want to say. There is no obligation to help unless asked. Up to three short bubbles. A bubble needs text or an approved sticker; mentions are optional and use exact observed member IDs, never all. Never invent member identity, image details, sticker IDs or execute assistant commands. Preserve the configured persona and its length/style limits. Images marked not-interpreted have not been understood. The JSON protocol is internal and must not appear in text.`

export function parseReply(text: string): ChatPacket[] | undefined {
  if (typeof text !== "string" || text.length > 12000) return undefined
  try {
    const value: unknown = JSON.parse(text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, "$1"))
    if (!record(value) || Object.keys(value).some((key) => key !== "messages") || !Array.isArray(value.messages) || value.messages.length > 3) return undefined
    const result: ChatPacket[] = []
    let total = 0
    for (const packet of value.messages) {
      if (!record(packet) || Object.keys(packet).some((key) => !["text", "mentions", "sticker"].includes(key)) ||
        packet.text !== undefined && (typeof packet.text !== "string" || !packet.text.trim() || packet.text.length > 1000 || packet.text.includes("\0")) ||
        packet.sticker !== undefined && (typeof packet.sticker !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(packet.sticker)) ||
        !packet.text && !packet.sticker || packet.mentions !== undefined && (!Array.isArray(packet.mentions) || packet.mentions.length > 4 || !packet.mentions.every(accountID))) return undefined
      total += typeof packet.text === "string" ? packet.text.length : 0
      if (total > 2400) return undefined
      result.push({ ...(typeof packet.text === "string" ? { text: packet.text } : {}),
        ...(typeof packet.sticker === "string" ? { sticker: packet.sticker } : {}),
        ...(Array.isArray(packet.mentions) ? { mentions: [...new Set(packet.mentions as string[])] } : {}) })
    }
    return result
  } catch { return undefined }
}
