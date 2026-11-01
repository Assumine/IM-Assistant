import { createHash } from "node:crypto"

// Valid one-pixel RGBA PNG; synthetic data only.
export const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII="
export const imageName = createHash("md5").update(Buffer.from(png, "base64")).digest("hex") + ".png"
export const imagePart = { type: "image", data: { file: imageName, url: "https://never-fetch.invalid/private", file_size: "65" } }
