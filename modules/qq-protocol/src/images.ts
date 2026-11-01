import { createHash } from "node:crypto"

// NapCat content identifiers only; returned paths/URLs must never be opened by the transport.
export const imageFile = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{32}\.(?:png|jpe?g|gif|webp|bmp)$/i.test(value)
export const maximumImageBytes = 20 * 1024 * 1024
export const imageFrameBytes = (maximum: number) => 4 * Math.ceil(maximum / 3) + 65536

function base64Image(data: string, maximum: number) {
  if (!data.length || data.length > 4 * Math.ceil(maximum / 3) || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return undefined
  const bytes = Buffer.from(data, "base64")
  if (bytes.length > maximum || bytes.toString("base64") !== data) return undefined
  const mime = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "image/jpeg"
    : ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6)) ? "image/gif"
    : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? "image/webp"
    : bytes.toString("ascii", 0, 2) === "BM" ? "image/bmp" : undefined
  return mime ? { bytes, mime, data } : undefined
}

/** Decode only authenticated inline bytes; path/URL fields are intentionally ignored. */
export function decodeImage(file: string, value: unknown, maximum: number) {
  if (!imageFile(file) || !value || typeof value !== "object" || !("base64" in value) || typeof value.base64 !== "string") return undefined
  const image = base64Image(value.base64, maximum)
  return image && createHash("md5").update(image.bytes).digest("hex") === file.slice(0, 32).toLowerCase()
    ? { uri: `data:${image.mime};base64,${image.data}`, name: file, byteLength: image.bytes.length } : undefined
}

/** Explicitly supplied sticker bytes only. No arbitrary filesystem path or remote URL. */
export function inlineImage(uri: string, maximum = maximumImageBytes) {
  if (typeof uri !== "string") return undefined
  const match = /^data:(image\/(?:png|jpeg|gif|webp|bmp));base64,([A-Za-z0-9+/]+=*)$/.exec(uri)
  if (!match) return undefined
  const image = base64Image(match[2]!, maximum)
  return image && image.mime === match[1] ? { file: "base64://" + image.data, byteLength: image.bytes.length } : undefined
}
