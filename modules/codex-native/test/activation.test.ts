import { expect, test } from "bun:test"
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { activation, configuredModule, createSharedProfile, setActivation } from "../src"

const root = process.env.IM_CODEX_TEST_ROOT
if (!root) throw new Error("Use tools.codex_native_smoke with an isolated profile")

test("absent activation stays disabled without creating or starting a native profile", async () => {
  const directory = path.join(await mkdtemp(path.join(root, "activation-")), "absent")
  expect(await activation(directory)).toEqual({ version: 1, enabled: false })
  expect(await configuredModule(directory)).toBeUndefined()
  await expect(stat(directory)).rejects.toThrow()
})

test("activation persists only explicit next-boot selection and keeps native profile contents", async () => {
  const directory = await mkdtemp(path.join(root, "activation-"))
  const profile = await createSharedProfile(directory)
  const configuration = await readFile(path.join(directory, "config.toml"), "utf8")
  const token = await readFile(profile.service!.tokenFile, "utf8")
  await expect(setActivation(directory, true, "relative")).rejects.toThrow("absolute")
  await setActivation(directory, true, process.execPath)
  expect(await activation(directory)).toEqual({ version: 1, enabled: true, executable: process.execPath })
  expect((await configuredModule(directory))?.id).toBe("codex-native")
  await setActivation(directory, false)
  await setActivation(directory, false)
  expect(await configuredModule(directory)).toBeUndefined()
  expect(await readFile(path.join(directory, "config.toml"), "utf8")).toBe(configuration)
  expect(await readFile(profile.service!.tokenFile, "utf8")).toBe(token)
})

test("activation rejects unknown keys, invalid identity fields and modified native policy", async () => {
  const directory = await mkdtemp(path.join(root, "activation-"))
  await createSharedProfile(directory)
  await setActivation(directory, false)
  const file = path.join(directory, "host-activation.json")
  for (const value of ["<html>", JSON.stringify({ version: 1, enabled: true }), JSON.stringify({ version: 1, enabled: false, plugin: "untrusted" }), JSON.stringify({ version: 2, enabled: false }), JSON.stringify({ version: 1, enabled: true, executable: "relative" })]) {
    await writeFile(file, value)
    await expect(configuredModule(directory)).rejects.toThrow()
  }
  await setActivation(directory, true, process.execPath)
  await writeFile(path.join(directory, "config.toml"), "\nshell_tool = true\n", { flag: "a" })
  await expect(configuredModule(directory)).rejects.toThrow("revalidation required")
})
