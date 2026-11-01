import path from "node:path"
import type { Account, ChatInput, Configuration } from "./types"
import { imageFile } from "../../qq-protocol/src/index"

const accountID = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value)
const text = (value: unknown, maximum: number): value is string => typeof value === "string" && !!value.trim() && value.length <= maximum && !value.includes("\0")

/** Snapshot owned configuration once. No global provider, agent or task-portal settings are changed. */
export function configuration(options: Configuration): Configuration {
  if (!options || !options.location || !path.isAbsolute(options.location.directory) ||
    !Array.isArray(options.accounts) || options.accounts.length < 1 || options.accounts.length > 8)
    throw new Error("Invalid QQ chatbot configuration")
  const accounts = options.accounts.map((value): Account => {
    if (!accountID(value.botID) || !value.model || !text(value.model.providerID, 256) || !text(value.model.id, 256) ||
      value.model.variant !== undefined && !text(value.model.variant, 256) ||
      value.agentID !== undefined && !text(value.agentID, 128) || !value.persona ||
      !text(value.persona.name, 80) || !text(value.persona.prompt, 16000)) throw new Error("Invalid QQ chatbot account")
    // Native Session.Info exposes an omitted variant as "default". Freeze that same explicit selection.
    return { botID: value.botID, model: { providerID: value.model.providerID, id: value.model.id, variant: value.model.variant ?? "default" },
      agentID: value.agentID ?? "build", persona: { name: value.persona.name, prompt: value.persona.prompt } }
  })
  if (new Set(accounts.map((value) => value.botID)).size !== accounts.length) throw new Error("Duplicate QQ chatbot account")
  return { location: { directory: path.resolve(options.location.directory) }, accounts }
}

export function validInput(value: ChatInput): boolean {
  return !!value && !!value.scope && accountID(value.scope.botID) && accountID(value.scope.peerID) &&
    ["private", "group"].includes(value.scope.kind) && accountID(value.actorID) && value.actorID !== value.scope.botID &&
    (value.scope.kind !== "private" || value.actorID === value.scope.peerID) &&
    text(value.messageID, 64) && /^-?(?:0|[1-9][0-9]{0,19})$/.test(value.messageID) && text(value.text, 16000) &&
    (value.displayName === undefined || text(value.displayName, 80)) &&
    (value.images === undefined || Array.isArray(value.images) && value.images.length <= 4 && value.images.every(imageFile)) &&
    (value.mentions === undefined || Array.isArray(value.mentions) && value.mentions.length <= 20 && value.mentions.every(accountID)) &&
    (value.quoteID === undefined || /^-?(?:0|[1-9][0-9]{0,19})$/.test(value.quoteID)) &&
    (value.files === undefined || Array.isArray(value.files) && value.files.length === value.images?.length && value.files.every((file, i) =>
      file.name === value.images![i] && file.source?.type === "inline" && typeof file.uri === "string" && /^data:image\/(?:png|jpeg|gif|webp|bmp);base64,/.test(file.uri)))
}
