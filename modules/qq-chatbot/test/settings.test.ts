import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { initializeSettings, readSettings, settings, settingsOwner, updateSettings } from "../src/settings"

const account = () => ({ botID: "10002", url: "ws://127.0.0.1:12345/", tokenEnv: "IM_QQ_CHAT_TOKEN_SHEEP",
  model: { providerID: "fixture", id: "fixture" }, persona: { name: "Sheep", prompt: "Synthetic persona" },
  policy: { privateUsers: ["20001"], groups: ["30001"] } })
const configuration = () => ({ version: 1, enabled: false, accounts: [account()] })
const signal = () => new AbortController().signal
async function temporary() {
  const home = await mkdtemp(path.join(tmpdir(), "qq-chat-settings-"))
  return { home, async [Symbol.asyncDispose]() { await rm(home, { recursive: true, force: true }) } }
}

test("missing chat configuration is off and initialization never overwrites an existing document", async () => {
  await using box = await temporary()
  expect(await readSettings(box.home)).toEqual({ version: 1, enabled: false, accounts: [] })
  await initializeSettings(box.home)
  await expect(initializeSettings(box.home)).rejects.toThrow()
  await expect(updateSettings(box.home, (value) => ({ ...value, enabled: true }))).rejects.toThrow()
  expect((await readSettings(box.home)).enabled).toBe(false)
})

test("declarative settings normalize native model/persona references without accepting credentials or task controls", () => {
  const input = configuration(), output = settings(input)
  input.accounts[0]!.persona.prompt = "caller changed"
  expect(output.accounts[0]).toMatchObject({ enabled: true, contextGeneration: 0, persona: { prompt: "Synthetic persona" },
    model: { providerID: "fixture", id: "fixture", variant: "default" }, policy: { groupReplies: "auto", repliesEnabled: true } })
  for (const extra of [{ token: "private-secret" }, { password: "private-secret" }, { controls: {} },
    { url: "wss://example.invalid/?token=private-secret" }, { tokenEnv: "IM_QQ_TOKEN_SHARED" },
    { model: { ...account().model, apiKey: "private-secret" } }]) {
    expect(() => settings({ ...configuration(), accounts: [{ ...account(), ...extra }] })).toThrow()
  }
})

test("only an explicit new context generation permits persona/model changes; previous settings remain intact on rejection", async () => {
  await using box = await temporary()
  await updateSettings(box.home, () => configuration())
  const before = await readFile(path.join(box.home, "channels.json"), "utf8")
  await expect(updateSettings(box.home, (value) => ({ ...value, accounts: value.accounts.map((item) => ({ ...item, persona: { name: "Other", prompt: "New persona" } })) })))
    .rejects.toThrow("Explicitly reset")
  expect(await readFile(path.join(box.home, "channels.json"), "utf8")).toBe(before)
  const next = await updateSettings(box.home, (value) => ({ ...value, accounts: value.accounts.map((item) => ({ ...item,
    contextGeneration: item.contextGeneration + 1, persona: { name: "Other", prompt: "New persona" } })) }))
  expect(next.accounts[0]?.contextGeneration).toBe(1)
  await expect(updateSettings(box.home, (value) => ({ ...value, accounts: value.accounts.map((item) => ({ ...item, contextGeneration: 0 })) }))).rejects.toThrow()
})

test("concurrent editors use a real cross-process file lease and exactly one matching revision can replace the document", async () => {
  await using box = await temporary()
  const owner = settingsOwner(box.home), previous = await owner.read(signal())
  const values = [configuration(), { ...configuration(), accounts: [{ ...account(), botID: "10003" }] }]
  const replies = await Promise.all(values.map((value) => owner.write({ revision: previous.revision, text: JSON.stringify(value) }, signal())))
  expect(replies.filter(Boolean)).toHaveLength(1)
  expect(replies.filter((value) => value === undefined)).toHaveLength(1)
  expect((await readSettings(box.home)).accounts[0]?.botID).toBe(JSON.parse(replies.find(Boolean)!.text).accounts[0].botID)
})

test("malformed or oversized settings are not exposed as a credential-bearing GUI document", async () => {
  await using box = await temporary()
  for (const body of ['{"version":1,"token":"private-secret"}', "<!DOCTYPE html>", "x".repeat(524289)]) {
    await writeFile(path.join(box.home, "channels.json"), body)
    await expect(settingsOwner(box.home).read(signal())).rejects.toThrow("unavailable")
  }
})

test("account identity/token ownership, media configuration and UTF8 byte budgets are validated before persistence", () => {
  const duplicate = configuration(); duplicate.accounts.push(account())
  expect(() => settings(duplicate)).toThrow("Duplicate")
  for (const fields of [{ contextGeneration: -1 }, { contextGeneration: 1.5 }, { images: { maxBytes: 0 } },
    { stickers: [{ id: "smile", label: "Smile", uri: "C:/private.png" }] }]) {
    expect(() => settings({ ...configuration(), accounts: [{ ...account(), ...fields }] })).toThrow()
  }
  const large = configuration()
  large.accounts = Array.from({ length: 8 }, (_, index) => ({ ...account(), botID: String(10002 + index),
    tokenEnv: "IM_QQ_CHAT_TOKEN_" + index, persona: { name: "Sheep", prompt: "羊".repeat(16000) } }))
  const png = Buffer.concat([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64"), Buffer.alloc(512)]).toString("base64")
  // UTF8 size, rather than JS character count, is the persistence boundary.
  expect(() => settings({ ...large, accounts: large.accounts.map((item) => ({ ...item, stickers: Array.from({ length: 32 }, (_, index) => ({
    id: "s" + index, label: "羊".repeat(80), uri: "data:image/png;base64," + png,
  })) })) })).toThrow("size limit")
})
