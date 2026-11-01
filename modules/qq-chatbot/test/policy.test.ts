import { expect, test } from "bun:test"
import { decode, directed, policy } from "../src/policy"

const rules = () => policy({ privateUsers: ["20001"], groups: ["30001"], ignoredUsers: ["10001"] })
const event = () => ({ post_type: "message", self_id: "10002", message_type: "group", group_id: "30001",
  user_id: "20002", message_id: -17, sender: { user_id: "20002", nickname: "Member B" },
  message: [{ type: "text", data: { text: "/stop [CQ:at,qq=all]" } }] })
const read = (value: unknown) => decode(value, "10002", rules(), ["10002", "10003"])

test("group readers and private whitelist are independent of task commands and task mentions", () => {
  const group = read(event())
  expect(group).toMatchObject({ actorID: "20002", text: "/stop [CQ:at,qq=all]", scope: { kind: "group", peerID: "30001" } })
  expect(typeof group !== "string" && directed(group, "小羊")).toBe(false)
  expect(read({ ...event(), message_type: "private" })).toBe("ignored")
  expect(read({ ...event(), message_type: "private", user_id: "20001", sender: { user_id: "20001" } })).toMatchObject({ actorID: "20001" })
})

test("foreign accounts, excluded bots and unconfigured groups do not enter chat context", () => {
  for (const change of [{ self_id: "10003" }, { user_id: "10003" }, { user_id: "10001" }, { group_id: "30002" },
    { post_type: "notice" }]) expect(read({ ...event(), ...change })).toBe("ignored")
})

test("structured media, member mentions and quote IDs preserve identity without interpreting CQ text", () => {
  const input = read({ ...event(), message: [
    { type: "image", data: { file: "a".repeat(32) + ".png", url: "file:///must-not-read" } },
    { type: "at", data: { qq: "10002" } }, { type: "at", data: { qq: "10002" } },
    { type: "face", data: { id: 14 } }, { type: "reply", data: { id: "-18" } },
  ] })
  expect(input).toMatchObject({ actorID: "20002", messageID: "-17", mentions: ["10002"], quoteID: "-18",
    images: ["a".repeat(32) + ".png"], text: "[QQ表情 14]" })
  expect(typeof input !== "string" && directed(input, "小羊")).toBe(true)
  expect(JSON.stringify(input)).not.toContain("must-not-read")
})

test("invalid or partially supported messages are rejected as a whole", () => {
  for (const message of [[{ type: "text", data: { text: "\0" } }], [{ type: "video", data: {} }],
    [...event().message, { type: "file", data: {} }], [{ type: "image", data: { file: "C:/private.png" } }],
    [{ type: "text", data: { text: "x".repeat(16001) } }], [{ type: "reply", data: { id: "1" } }, { type: "reply", data: { id: "2" } }]]) {
    expect(read({ ...event(), message })).toBe("unsupported")
  }
})

test("unsafe numeric identity and conflicting sender fields cannot silently attribute a message to a different member", () => {
  expect(read({ ...event(), message_id: Number.MAX_SAFE_INTEGER + 1 })).toBe("unsupported")
  expect(read({ ...event(), message: [{ type: "reply", data: { id: Number.MAX_SAFE_INTEGER + 1 } }] })).toBe("unsupported")
  expect(read({ ...event(), sender: { user_id: "20001" } })).toBe("unsupported")
  expect(read({ ...event(), user_id: Number.MAX_SAFE_INTEGER + 1 })).toBe("ignored")
})

test("policy is snapshotted and rejects duplicate scope entries and invalid switch modes", () => {
  const source = { privateUsers: ["20001"], groups: ["30001"] }, saved = policy(source)
  source.groups.push("30002")
  expect(saved.groups).toEqual(["30001"])
  expect(saved.groupReplies).toBe("auto")
  expect(saved.repliesEnabled).toBe(true)
  expect(() => policy({ privateUsers: [], groups: ["30001", "30001"] })).toThrow()
  expect(() => policy({ privateUsers: [], groups: ["../room"] })).toThrow()
})
