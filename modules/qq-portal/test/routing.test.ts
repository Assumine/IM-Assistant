import { expect, test } from "bun:test"
import { command, decode, fingerprint, inputID, originKey } from "../src/routing"

const policy = { botID: "10001", allowedUsers: ["20001", "20002"], allowedGroups: ["30001"] }
const privateEvent = { post_type: "message", message_type: "private", self_id: 10001, user_id: 20001, message_id: -11, message: [{ type: "text", data: { text: "hello" } }] }
const groupEvent = { ...privateEvent, message_type: "group", group_id: 30001, message: [{ type: "at", data: { qq: "10001" } }, ...privateEvent.message] }

for (const [name, event, kind] of [
  ["private", privateEvent, "message"], ["group", groupEvent, "message"],
  ["other bot or companion", { ...groupEvent, self_id: 10002 }, "ignored"],
  ["outgoing message", { ...groupEvent, post_type: "message_sent" }, "ignored"],
  ["self loop", { ...privateEvent, user_id: 10001 }, "ignored"],
  ["private outsider", { ...privateEvent, user_id: 99999 }, "ignored"],
  ["group outsider", { ...groupEvent, user_id: 99999 }, "ignored"],
  ["other group", { ...groupEvent, group_id: 30002 }, "ignored"],
  ["group without at", { ...groupEvent, message: privateEvent.message }, "ignored"],
  ["at another member", { ...groupEvent, message: [{ type: "at", data: { qq: 20002 } }, ...privateEvent.message] }, "ignored"],
  ["invalid actor", { ...privateEvent, user_id: 1.2 }, "ignored"],
  ["invalid message", { ...privateEvent, message_id: "../other" }, "unsupported"],
  ["raw CQ text", { ...privateEvent, message: "[CQ:at,qq=10001]hello" }, "unsupported"],
  ["image not silently discarded", { ...privateEvent, message: [...privateEvent.message, { type: "image", data: { file: "private-path" } }] }, "unsupported"],
  ["multiple replies", { ...privateEvent, message: [{ type: "reply", data: { id: 1 } }, { type: "reply", data: { id: 2 } }, ...privateEvent.message] }, "unsupported"],
  ["recall needs no at", { ...groupEvent, post_type: "notice", notice_type: "group_recall", message: undefined }, "recall"],
  ["unrelated notice", { ...privateEvent, post_type: "notice", notice_type: "heartbeat" }, "ignored"],
] as const) test(`OneBot boundary: ${name}`, () => expect(decode(event, policy).kind).toBe(kind))

test("decoded identity is separate from visible text and scope IDs never collide", () => {
  const event = decode({ ...groupEvent, message: [{ type: "at", data: { qq: 10001 } }, { type: "reply", data: { id: "-5" } }, { type: "text", data: { text: " [[msg:literal]] hello " } }] }, policy)
  if (event.kind !== "message") throw new Error("Message expected")
  expect(event.message.text).toBe(" [[msg:literal]] hello ")
  expect(event.message.quoteID).toBe("-5")
  expect(event.message.actorID).toBe("20001")
  const hash = originKey(event.message.scope, "-11")
  expect(hash).not.toBe(originKey({ ...event.message.scope, kind: "private" }, "-11"))
  expect(hash).not.toBe(originKey({ ...event.message.scope, botID: "10002" }, "-11"))
  expect(inputID(event.message)).toStartWith("msg_qq_")
  expect(fingerprint(event.message)).not.toBe(fingerprint({ ...event.message, actorID: "20002" }))
})

for (const text of ["/LIST", "/List", "/codex list", "/CODEX LIST", "Codex List"]) test(`command before scheduling: ${text}`, () => expect(command(text)).toEqual({ action: "list", arguments: "" }))
for (const text of ["LIST", "Status", "Please /stop", "/unknown", "codex explain"]) test(`ordinary input stays ordinary: ${text}`, () => expect(command(text)).toBeUndefined())
test("command arguments retain their case and content", () => expect(command("/CoDeX Queue Fix ABC\nKeep XYZ")).toEqual({ action: "queue", arguments: "Fix ABC\nKeep XYZ" }))
test("legacy bare codex remains a control request", () => expect(command("Codex")).toEqual({ action: "help", arguments: "" }))
test("legacy bare bind remains a control request", () => expect(command("Bind ses_ABC")).toEqual({ action: "bind", arguments: "ses_ABC" }))
