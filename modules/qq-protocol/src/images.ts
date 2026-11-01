// NapCat content identifiers only; returned paths/URLs must never be opened by the transport.
export const imageFile = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{32}\.(?:png|jpe?g|gif|webp|bmp)$/i.test(value)
export const maximumImageBytes = 20 * 1024 * 1024
export const imageFrameBytes = (maximum: number) => 4 * Math.ceil(maximum / 3) + 65536
