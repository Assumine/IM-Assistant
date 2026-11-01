import { expect, test } from "bun:test"
import { parseReply } from "../src/replies"

test("structured replies permit abstention, separate bubbles, observed mentions and named sticker assets", () => {
  expect(parseReply('{"messages":[]}')).toEqual([])
  expect(parseReply(JSON.stringify({ messages: [{ text: "一条短回复", mentions: ["20002", "20002"] }, { sticker: "smile" }] })))
    .toEqual([{ text: "一条短回复", mentions: ["20002"] }, { sticker: "smile" }])
  expect(parseReply('```json\n{"messages":[{"text":"[CQ:at,qq=all]"}]}\n```')).toEqual([{ text: "[CQ:at,qq=all]" }])
})

test("plain text or invented output fields never escape the internal reply protocol", () => {
  for (const value of ["raw reply", "<!DOCTYPE html>", '{"messages":[],"tool":"execute"}',
    '{"messages":[{"text":"hello","url":"https://example.invalid"}]}', '{"messages":[null]}', '{"messages":[{}]}']) {
    expect(parseReply(value)).toBeUndefined()
  }
})

test("mass mentions, URL/path stickers and mention-only packets cannot become QQ operations", () => {
  for (const packet of [{ text: "x", mentions: ["all"] }, { text: "x", mentions: ["../member"] },
    { sticker: "https://example.invalid/a.png" }, { sticker: "C:/private.png" }, { mentions: ["20002"] },
    { text: "\0" }, { text: " " }]) expect(parseReply(JSON.stringify({ messages: [packet] }))).toBeUndefined()
})

test("one generation is bounded to three short bubbles and a fixed total text budget", () => {
  for (const messages of [Array.from({ length: 4 }, () => ({ text: "x" })), [{ text: "x".repeat(1001) }],
    Array.from({ length: 3 }, () => ({ text: "x".repeat(801) }))]) {
    expect(parseReply(JSON.stringify({ messages }))).toBeUndefined()
  }
})
