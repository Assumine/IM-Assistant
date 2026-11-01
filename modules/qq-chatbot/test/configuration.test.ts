import { expect, test } from "bun:test"
import path from "node:path"
import { configuration, validInput } from "../src/configuration"
import { createChatbotModule, nativeSessionID } from "../src/index"

const options = () => ({ location: { directory: path.resolve(".") }, accounts: [{ botID: "10002",
  model: { providerID: "fixture", id: "fixture" }, persona: { name: "Sheep", prompt: "A synthetic chat persona." } }] })
const input = () => ({ scope: { botID: "10002", kind: "private" as const, peerID: "20001" }, actorID: "20001", messageID: "1", text: "Hello" })

test("configuration snapshots personality and model without changing the caller's native settings", () => {
  const caller = options(), config = configuration(caller)
  caller.accounts[0]!.persona.prompt = "Later change"
  caller.accounts[0]!.model.id = "later-model"
  expect(config.accounts[0]?.persona.prompt).toBe("A synthetic chat persona.")
  expect(config.accounts[0]?.model.id).toBe("fixture")
  expect(config.accounts[0]?.model.variant).toBe("default")
  expect(config.accounts[0]?.agentID).toBe("build")
})

test("duplicate accounts and missing personality are rejected before native resources open", () => {
  const config = options(); config.accounts.push(config.accounts[0]!)
  expect(() => configuration(config)).toThrow("Duplicate QQ chatbot account")
  config.accounts.pop(); config.accounts[0]!.persona.prompt = " "
  expect(() => configuration(config)).toThrow("Invalid QQ chatbot account")
})

test("sessions require an explicitly managed absolute location", () => {
  const config = options(); config.location.directory = "relative"
  expect(() => configuration(config)).toThrow("Invalid QQ chatbot configuration")
})

test("private-chat actor must match the peer and cannot be the bot", () => {
  expect(validInput(input())).toBe(true)
  expect(validInput({ ...input(), actorID: "20002" })).toBe(false)
  expect(validInput({ ...input(), actorID: "10002" })).toBe(false)
})

test("group scope is shared by members and remains separate from private or other bot scopes", () => {
  const group = { botID: "10002", kind: "group" as const, peerID: "30001" }
  expect(validInput({ ...input(), scope: group, actorID: "20002" })).toBe(true)
  const ids = [group, { ...group, peerID: "30002" }, { ...group, botID: "10003" },
    { ...group, kind: "private" as const }].map(nativeSessionID)
  expect(new Set(ids).size).toBe(4)
  expect(nativeSessionID({ peerID: group.peerID, kind: group.kind, botID: group.botID })).toBe(ids[0])
})

test("invalid content and member identifiers cannot be admitted", () => {
  for (const change of [{ text: " " }, { text: "x".repeat(16001) }, { actorID: "../user" }, { messageID: "CQ:1" },
    { displayName: "x".repeat(81) }, { text: "\0" }]) expect(validInput({ ...input(), ...change })).toBe(false)
})

test("the independent ingress port refuses messages before native module startup", async () => {
  const module = createChatbotModule(options())
  expect(module.id).toBe("qq-chatbot")
  expect(await module.receive(input())).toEqual({ status: "unavailable" })
})
