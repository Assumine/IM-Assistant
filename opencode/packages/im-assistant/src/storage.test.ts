import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Profile } from "./profile.js"
import { Storage } from "./storage.js"

const environment = { ...process.env }
const roots: string[] = []
afterEach(() => {
  process.env = { ...environment }
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }))
})

test("only the explicit personal profile activates the assistant identity", () => {
  for (const [value, active] of [[undefined, false], ["personal", true], ["other", false]] as const) {
    if (value === undefined) delete process.env.IM_ASSISTANT_PROFILE
    if (value !== undefined) process.env.IM_ASSISTANT_PROFILE = value
    expect(Profile.active()).toBe(active)
  }
})

test("a relative data root is rejected before preparing storage", () => {
  for (const value of ["", "relative", "../other-app"]) {
    process.env.IM_ASSISTANT_DATA_ROOT = value
    expect(() => Storage.prepare()).toThrow("must be absolute")
  }
})

test("assistant storage overrides inherited routing while preserving native config on reopen", () => {
  const root = mkdtempSync(path.join(tmpdir(), "im-assistant-profile-"))
  roots.push(root)
  process.env.IM_ASSISTANT_DATA_ROOT = root
  process.env.OPENCODE_DB = path.join(root, "wrong-legacy.db")
  process.env.OPENCODE_CONFIG_CONTENT = '{"username":"legacy"}'
  process.env.OPENCODE_PASSWORD = "legacy-private-test-value"
  process.env.XDG_STATE_HOME = path.join(root, "wrong-state")
  const home = process.env.HOME
  const first = Storage.prepare()
  const file = path.join(first.nativeConfig, Profile.serviceFile)
  const value = { hostname: "127.0.0.1", port: 28717, password: "synthetic-local-only" }
  writeFileSync(file, JSON.stringify(value))
  const second = Storage.prepare()
  expect(second).toEqual(first)
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(value)
  expect(process.env.OPENCODE_DB).toBe(first.database)
  expect(process.env.OPENCODE_CONFIG_DIR).toBe(first.nativeConfig)
  expect(process.env.XDG_STATE_HOME).toBe(first.state)
  expect(process.env.OPENCODE_CONFIG_CONTENT).toBeUndefined()
  expect(process.env.OPENCODE_PASSWORD).toBeUndefined()
  expect(process.env.HOME).toBe(home)
})
