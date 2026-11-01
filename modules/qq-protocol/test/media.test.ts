import { createHash } from "node:crypto"
import { expect, test } from "bun:test"
import { decodeImage, inlineImage, openOneBot } from "../src/index"
import { fakeOneBot } from "./fixture/onebot"

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII="
const bytes = Buffer.from(png, "base64"), uri = "data:image/png;base64," + png
const file = createHash("md5").update(bytes).digest("hex") + ".png"
const group = { botID: "10001", kind: "group" as const, peerID: "30001" }

test("authenticated image decoding verifies the content ID and uses inline bytes while ignoring returned paths", () => {
  expect(decodeImage(file, { base64: png, file: "C:/private.png", url: "https://example.invalid" }, bytes.length))
    .toEqual({ uri, name: file, byteLength: bytes.length })
  expect(inlineImage(uri)).toEqual({ file: "base64://" + png, byteLength: bytes.length })
})

test("image codec rejects mismatched hashes, oversized bytes, external sources and misleading MIME types", () => {
  expect(decodeImage("0".repeat(32) + ".png", { base64: png }, 1024)).toBeUndefined()
  expect(decodeImage(file, { base64: png }, bytes.length - 1)).toBeUndefined()
  expect(decodeImage(file, { file: "C:/private.png", url: "https://example.invalid" }, 1024)).toBeUndefined()
  for (const value of ["C:/private.png", "https://example.invalid/p.png", "data:image/jpeg;base64," + png,
    "data:image/png;base64," + Buffer.from("not an image").toString("base64"), uri + "!", uri.replace(";base64,", ";base64, ")]) {
    expect(inlineImage(value)).toBeUndefined()
  }
})

test("shared send emits structured group mentions and image bytes with an optional original-message quote", async () => {
  const fixture = fakeOneBot(), wire = openOneBot({ url: fixture.url, token: fixture.token, botID: "10001" }, { event() {} })
  try {
    await wire.ready
    expect((await wire.sendMessage(group, [{ type: "mention", memberID: "20002" },
      { type: "text", text: "[CQ:at,qq=all]" }, { type: "image", uri }], "-17")).status).toBe("sent")
    expect((await wire.sendMessage(group, [{ type: "text", text: "second bubble" }])).status).toBe("sent")
    const calls = fixture.calls.filter((call) => call.action.startsWith("send_"))
    expect(calls[0]?.params.message).toEqual([{ type: "reply", data: { id: "-17" } }, { type: "at", data: { qq: "20002" } },
      { type: "text", data: { text: "[CQ:at,qq=all]" } }, { type: "image", data: { file: "base64://" + png } }])
    expect(calls[1]?.params.message).toEqual([{ type: "text", data: { text: "second bubble" } }])
  } finally { wire.close(); fixture.close() }
})

test("invalid mixed output is rejected before transport; private or mass mentions and old sends without a quote remain unavailable", async () => {
  const fixture = fakeOneBot(), wire = openOneBot({ url: fixture.url, token: fixture.token, botID: "10001" }, { event() {} })
  try {
    await wire.ready
    expect(await wire.sendMessage(group, [{ type: "text", text: "must not send partially" }, { type: "image", uri: "C:/private.png" }]))
      .toEqual({ status: "unavailable" })
    expect(await wire.sendMessage(group, [{ type: "mention", memberID: "all" }])).toEqual({ status: "unavailable" })
    expect(await wire.sendMessage({ ...group, kind: "private", peerID: "20001" }, [{ type: "mention", memberID: "20001" }]))
      .toEqual({ status: "unavailable" })
    expect(await wire.send(group, "old task contract", "invalid")).toEqual({ status: "unavailable" })
    expect(fixture.calls.filter((call) => call.action.startsWith("send_"))).toHaveLength(0)
    expect((await wire.send(group, "old task contract", "17")).status).toBe("sent")
  } finally { wire.close(); fixture.close() }
})
