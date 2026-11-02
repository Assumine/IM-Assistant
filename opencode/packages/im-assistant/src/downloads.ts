export * as Downloads from "./downloads.js"

import path from "node:path"
import { access } from "node:fs/promises"
import { Storage } from "./storage.js"
import type { ApplicationModuleSettings } from "@opencode/plugin/promise/application"

export function home() {
  return path.join(Storage.root(), "modules", "downloads")
}
export function executable() {
  return path.resolve(import.meta.dirname, "../../../../runtime/tools/aria2-1.37.0/aria2c.exe")
}
export function settings(): ApplicationModuleSettings {
  return {
    async read(signal) {
      const { settingsOwner } = await import("../../../../modules/downloads/src/configuration")
      return settingsOwner(home()).read(signal)
    },
    async write(input, signal) {
      const { settingsOwner } = await import("../../../../modules/downloads/src/configuration")
      return settingsOwner(home()).write(input, signal)
    },
  }
}
export async function load() {
  const { readConfiguration } = await import("../../../../modules/downloads/src/configuration")
  const config = await readConfiguration(home())
  if (!config.enabled) return undefined
  await access(executable())
  const { createDownloadModule } = await import("../../../../modules/downloads/src/module")
  return createDownloadModule({ home: home(), executable: executable(), config })
}
export async function command(args: readonly string[]) {
  if (args.length !== 1 || !["init", "status", "enable", "disable"].includes(args[0]!))
    throw new Error("Use downloads init|status|enable|disable")
  const { readConfiguration, settingsOwner } = await import("../../../../modules/downloads/src/configuration")
  const owner = settingsOwner(home())
  const signal = new AbortController().signal
  if (args[0] !== "status") {
    const previous = await owner.read(signal)
    const config = JSON.parse(previous.text)
    if (args[0] !== "init") config.enabled = args[0] === "enable"
    if (!(await owner.write({ revision: previous.revision, text: JSON.stringify(config) }, signal)))
      throw new Error("Download settings changed")
  }
  const config = await readConfiguration(home())
  return { module: "downloads", enabled: config.enabled, appliesTo: "next-service-start", transfersStarted: false }
}
