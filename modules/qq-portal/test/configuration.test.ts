import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { configuration, configuredModule, initialize, readConfiguration, setEnabled, type Configuration } from "../src"
import { fakeOneBot, policy } from "./fixture/onebot"

const account = () => ({ policy: structuredClone(policy), url: "ws://127.0.0.1:6700/", tokenEnv: "IM_QQ_TOKEN_FIXTURE", controls: { allowedUsers: ["20001"], backendIDs: ["codex-native"] } })

test("declarative configuration refuses credentials, arbitrary code, duplicate accounts and widened command permissions", () => {
  const base = { version: 1, enabled: true, accounts: [account()] } satisfies Configuration
  expect(configuration(base)).toEqual(base)
  const invalid: unknown[] = [
    { ...base, plugin: "arbitrary-code" }, { ...base, accounts: [account(), account()] }, { ...base, accounts: [] },
    { ...base, accounts: [{ ...account(), token: "never-store-this" }] },
    { ...base, accounts: [{ ...account(), tokenEnv: "OPENAI_API_KEY" }] },
    { ...base, accounts: [{ ...account(), url: "wss://example.com/?access_token=never-store-this" }] },
    { ...base, accounts: [{ ...account(), url: "ws://example.com/" }] },
    { ...base, accounts: [{ ...account(), controls: { allowedUsers: ["99999"] } }] },
    { ...base, accounts: [{ ...account(), controls: { allowedUsers: ["20001"], backendIDs: ["opencode"] } }] },
  ]
  for (const value of invalid) expect(() => configuration(value)).toThrow()
  const cloned = configuration(base)
  base.accounts[0]!.policy.allowedUsers.push("20003")
  expect(cloned.accounts[0]!.policy.allowedUsers).toEqual(["20001", "20002"])
})

test("initialization is disabled, refuses adoption, and explicit activation preserves account metadata without credentials", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "qq-settings-"))
  try {
    expect(await readConfiguration(home)).toEqual({ version: 1, enabled: false, accounts: [] })
    expect(await configuredModule(home)).toBeUndefined()
    await initialize(home)
    await expect(initialize(home)).rejects.toThrow()
    await expect(setEnabled(home, true)).rejects.toThrow()
    await writeFile(path.join(home, "channels.json"), JSON.stringify({ version: 1, enabled: false, accounts: [account()] }))
    await setEnabled(home, true)
    expect(await readConfiguration(home)).toEqual({ version: 1, enabled: true, accounts: [account()] })
    await setEnabled(home, false)
    expect((await readConfiguration(home)).enabled).toBe(false)
    expect((await readConfiguration(home)).accounts).toEqual([account()])
    expect(await readFile(path.join(home, "channels.json"), "utf8")).not.toContain("Bearer")
  } finally { await rm(home, { recursive: true, force: true }) }
})

test("bad settings never expose raw credentials in errors or open a socket", async () => {
  const fake = fakeOneBot(), home = await mkdtemp(path.join(tmpdir(), "qq-invalid-settings-"))
  try {
    await writeFile(path.join(home, "channels.json"), JSON.stringify({ version: 1, enabled: true, accounts: [{ ...account(), token: fake.token }] }))
    try { await configuredModule(home); throw new Error("Expected invalid configuration") }
    catch (error) { expect(String(error)).toBe("Error: QQ configuration is unavailable"); expect(String(error)).not.toContain(fake.token) }
    await writeFile(path.join(home, "channels.json"), " ".repeat(524289))
    await expect(readConfiguration(home)).rejects.toThrow("QQ configuration is unavailable")
    expect(fake.upgrades).toEqual([])
  } finally { fake.close(); await rm(home, { recursive: true, force: true }) }
})

test("loading configured code consumes only enabled dedicated token variables without connecting or starting an AI task", async () => {
  const fake = fakeOneBot(), home = await mkdtemp(path.join(tmpdir(), "qq-token-reference-"))
  try {
    const environment = { IM_QQ_TOKEN_FIXTURE: fake.token, UNRELATED_TOKEN: "untouched" }
    await writeFile(path.join(home, "channels.json"), JSON.stringify({ version: 1, enabled: false, accounts: [{ ...account(), url: fake.url }] }))
    expect(await configuredModule(home, environment)).toBeUndefined()
    expect(environment.IM_QQ_TOKEN_FIXTURE).toBe(fake.token)
    await setEnabled(home, true)
    expect((await configuredModule(home, environment))?.id).toBe("qq-portal")
    expect(environment.IM_QQ_TOKEN_FIXTURE).toBeUndefined()
    expect(environment.UNRELATED_TOKEN).toBe("untouched")
    expect(fake.upgrades).toEqual([])
    expect(await readFile(path.join(home, "channels.json"), "utf8")).not.toContain(fake.token)
  } finally { fake.close(); await rm(home, { recursive: true, force: true }) }
})

test("history is an explicit bounded account capability rather than an implicit universal OneBot assumption", () => {
  const value = configuration({ version: 1, enabled: true, accounts: [{ ...account(), history: { provider: "napcat", pageSize: 20, maxPages: 5 } }] })
  expect(value.accounts[0]!.history).toEqual({ provider: "napcat", pageSize: 20, maxPages: 5 })
  expect(configuration({ version: 1, enabled: true, accounts: [account()] }).accounts[0]!.history).toBeUndefined()
  expect(() => configuration({ version: 1, enabled: true, accounts: [{ ...account(), history: { provider: "arbitrary", code: "no" } }] })).toThrow()
})
