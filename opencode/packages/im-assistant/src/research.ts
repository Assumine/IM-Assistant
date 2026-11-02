export * as Research from "./research.js"

import path from "node:path"
import { lstat, readFile } from "node:fs/promises"
import type { ApplicationModuleSettings } from "@opencode/plugin/promise/application"
import { Storage } from "./storage.js"

export function home() { return path.join(Storage.root(), "modules", "research") }
export function settings(): ApplicationModuleSettings {
  return {
    async read(signal) { const { settingsOwner } = await import("../../../../modules/research/src/index"); return settingsOwner(home()).read(signal) },
    async write(input, signal) { const { settingsOwner } = await import("../../../../modules/research/src/index"); return settingsOwner(home()).write(input, signal) },
  }
}
export async function load() {
  const { configuredResearch } = await import("../../../../modules/research/src/index")
  return configuredResearch(home())
}
export async function command(args: readonly string[]) {
  if (args.length < 1 || args.length > 2 || !["init", "status", "enable", "disable", "configure"].includes(args[0]!) ||
    (args[0] === "configure" ? args.length !== 2 : args.length !== 1)) throw new Error("Use research init|status|enable|disable or configure <absolute-json-file>")
  const { initializeConfiguration, readConfiguration, settingsOwner } = await import("../../../../modules/research/src/index")
  if (args[0] === "init") await initializeConfiguration(home())
  if (["configure", "enable", "disable"].includes(args[0]!)) {
    const owner = settingsOwner(home()), signal = new AbortController().signal, previous = await owner.read(signal)
    let text: string
    if (args[0] === "configure") {
      const file = args[1]!
      if (!path.isAbsolute(file)) throw new Error("Use an explicit absolute settings file")
      const stat = await lstat(file)
      if (!stat.isFile() || stat.size > 65536) throw new Error("Research settings input is unavailable")
      text = await readFile(file, "utf8")
    } else text = JSON.stringify({ ...JSON.parse(previous.text), enabled: args[0] === "enable" })
    if (!await owner.write({ revision: previous.revision, text }, signal)) throw new Error("Research settings changed; reload before saving")
  }
  const value = await readConfiguration(home())
  return { module: "research", enabled: value.enabled, sourceCount: value.sources.length, mcpEnabled: value.mcp.enabled,
    appliesTo: "next-service-start", tasksStarted: false, connectionVerified: false }
}
