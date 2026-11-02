import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { configuration, configuredResearch, initializeConfiguration, readConfiguration, settingsOwner } from "../src/index"

const defaults = () => ({ version: 1 as const, enabled: false, sources: [], mcp: { enabled: false, port: 0, clients: [] } })

test("product configuration defaults off and never consumes dormant MCP credentials", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "research-off-"))
  const environment = { IM_RESEARCH_MCP_TOKEN_TEST: "synthetic-credential-not-consumed" }
  try {
    expect(await readConfiguration(home)).toEqual(defaults())
    expect(await configuredResearch(home, environment)).toBeUndefined()
    await initializeConfiguration(home)
    await expect(initializeConfiguration(home)).rejects.toThrow()
    expect(await readConfiguration(home)).toEqual(defaults())
    expect(environment.IM_RESEARCH_MCP_TOKEN_TEST).toBe("synthetic-credential-not-consumed")
  } finally { await rm(home, { recursive: true, force: true }) }
})

test("host approvals reject executable or secret configuration, ambiguous origins and unbound external execution", () => {
  const invalid = [
    { ...defaults(), program: "return input" },
    { ...defaults(), token: "synthetic-private-secret" },
    ...["http://example.test", "https://user:secret@example.test", "https://example.test/path", "https://example.test/?token=private", "file:///private"].map((origin) => ({ ...defaults(), sources: [{ id: "a", origin }] })),
    { ...defaults(), sources: [{ id: "a", origin: "https://example.test", minimumIntervalMs: 4999 }] },
    { ...defaults(), sources: [{ id: "a", origin: "https://example.test" }, { id: "b", origin: "https://example.test/" }] },
    { ...defaults(), mcp: { enabled: true, port: 0, clients: [] } },
    { ...defaults(), mcp: { enabled: true, port: 0, clients: [{ tokenEnv: "RAW_SECRET", backendID: "opencode", threadID: "ses_test" }] } },
    { ...defaults(), mcp: { enabled: true, port: 0, clients: [{ tokenEnv: "IM_RESEARCH_MCP_TOKEN_TEST", backendID: "external", threadID: "thread_test", inputID: "msg_unproven" }] } },
    { ...defaults(), scoring: { initial: 1, failurePenalty: 0, successReward: 0.2, historicalFailurePenalty: 0.1 } },
  ]
  for (const value of invalid) expect(() => configuration(value)).toThrow()
  expect(configuration({ ...defaults(), sources: [{ id: "local", origin: "http://127.0.0.1:12345/", minimumIntervalMs: 5000 }] }).sources[0]!.origin).toBe("http://127.0.0.1:12345")
  expect(configuration({ ...defaults(), mcp: { enabled: true, port: 0, clients: [{ tokenEnv: "IM_RESEARCH_MCP_TOKEN_TEST", backendID: "external", threadID: "thread_authoring_only" }] } }).mcp.enabled).toBe(true)
})

test("actual settings persistence arbitrates concurrent revisions and aborted writes leave the previous configuration intact", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "research-settings-")), signal = new AbortController().signal
  try {
    const settings = settingsOwner(home), previous = await settings.read(signal)
    const desired = { ...defaults(), enabled: true, sources: [{ id: "public", origin: "https://example.test" }] }
    const writes = await Promise.all([desired, { ...desired, enabled: false }].map((value) => settings.write({ revision: previous.revision, text: JSON.stringify(value) }, signal)))
    expect(writes.filter(Boolean)).toHaveLength(1)
    const saved = await settings.read(signal)
    expect(saved.appliesTo).toBe("next-service-start")
    expect(saved.revision).not.toBe(previous.revision)
    expect(await readFile(path.join(home, "research.json"), "utf8")).toBe(saved.text)
    const cancelled = new AbortController(); cancelled.abort()
    await expect(settings.write({ revision: saved.revision, text: JSON.stringify(defaults()) }, cancelled.signal)).rejects.toThrow()
    await expect(settings.write({ revision: saved.revision, text: JSON.stringify({ ...desired, token: "synthetic-private-secret" }) }, signal)).rejects.toThrow()
    expect((await settings.read(signal)).revision).toBe(saved.revision)
    expect(await readFile(path.join(home, "research.json"), "utf8")).not.toContain("synthetic-private-secret")
  } finally { await rm(home, { recursive: true, force: true }) }
})

test("enabling local MCP requires supplied environment credentials without copying secrets into settings or errors", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "research-mcp-config-")), signal = new AbortController().signal
  try {
    const settings = settingsOwner(home), previous = await settings.read(signal)
    await settings.write({ revision: previous.revision, text: JSON.stringify({ ...defaults(), enabled: true,
      mcp: { enabled: true, port: 0, clients: [{ tokenEnv: "IM_RESEARCH_MCP_TOKEN_TEST", backendID: "opencode", threadID: "ses_owner" }] } }) }, signal)
    await expect(configuredResearch(home, {})).rejects.toThrow("credentials are unavailable")
    const environment = { IM_RESEARCH_MCP_TOKEN_TEST: "synthetic-invalid secret" }
    await expect(configuredResearch(home, environment)).rejects.toThrow("credentials are unavailable")
    expect(environment.IM_RESEARCH_MCP_TOKEN_TEST).toBeUndefined()
    expect((await settings.read(signal)).text).not.toContain("synthetic-invalid secret")
  } finally { await rm(home, { recursive: true, force: true }) }
})
