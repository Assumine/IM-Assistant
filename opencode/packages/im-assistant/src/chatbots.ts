export * as Chatbots from "./chatbots.js"

import path from "node:path"
import { lstat, readFile } from "node:fs/promises"
import type { ApplicationModuleSettings } from "@opencode/plugin/promise/application"
import { Storage } from "./storage.js"

export function home() {
  return path.join(Storage.root(), "modules", "qq-chatbot")
}

export function settings(): ApplicationModuleSettings {
  return {
    async read(signal) {
      const { settingsOwner } = await import("../../../../modules/qq-chatbot/src/index")
      return settingsOwner(home()).read(signal)
    },
    async write(input, signal) {
      const { settingsOwner } = await import("../../../../modules/qq-chatbot/src/index")
      return settingsOwner(home()).write(input, signal)
    },
  }
}

export async function load() {
  const { configuredChatbot } = await import("../../../../modules/qq-chatbot/src/index")
  return configuredChatbot(home(), { directory: Storage.paths(Storage.root()).location }, process.env, {
    onIssue: (issue) => console.warn(JSON.stringify({ module: "qq-chatbot", issue: issue.kind })),
  })
}

/** Configuration commands never connect QQ, generate a response, or mutate native task/history storage. */
export async function command(args: readonly string[]) {
  if (args.length < 2 || args.length > 3 || args[0] !== "qq" ||
    !["init", "enable", "disable", "status", "configure", "reset"].includes(args[1]!) ||
    args[1] === "init" && args.length !== 2 || ["configure", "reset"].includes(args[1]!) && args.length !== 3)
    throw new Error("Use chat qq init|status|enable|disable [botID], configure <absolute-json-file>, or reset <botID>")
  if (args[2] !== undefined && args[1] !== "configure" && !/^[1-9][0-9]{0,19}$/.test(args[2]))
    throw new Error("QQ chat account is not configured")
  const { initializeSettings, readSettings, updateSettings } = await import("../../../../modules/qq-chatbot/src/index")
  if (args[1] === "init") await initializeSettings(home())
  if (args[1] === "configure") {
    const file = args[2]!
    if (!path.isAbsolute(file)) throw new Error("Use an explicit absolute settings file")
    const stat = await lstat(file)
    if (!stat.isFile() || stat.size > 524288) throw new Error("Settings input is unavailable")
    const text = await readFile(file, "utf8")
    await updateSettings(home(), () => JSON.parse(text))
  }
  if (["enable", "disable", "reset"].includes(args[1]!)) await updateSettings(home(), (value) => {
    if (args[2] === undefined) return { ...value, enabled: args[1] === "enable" }
    if (!value.accounts.some((account) => account.botID === args[2])) throw new Error("QQ chat account is not configured")
    return { ...value, accounts: value.accounts.map((account) => account.botID !== args[2] ? account : args[1] === "reset"
      ? { ...account, contextGeneration: account.contextGeneration + 1 } : { ...account, enabled: args[1] === "enable" }) }
  })
  const config = await readSettings(home())
  const selected = args[2] && args[1] !== "configure" ? config.accounts.find((account) => account.botID === args[2]) : undefined
  if (args[2] && args[1] !== "configure" && !selected) throw new Error("QQ chat account is not configured")
  return { module: "qq-chatbot", enabled: config.enabled && (selected ? selected.enabled : true),
    moduleEnabled: config.enabled, accountCount: config.accounts.length,
    enabledAccountCount: config.enabled ? config.accounts.filter((account) => account.enabled).length : 0,
    ...(selected ? { botID: selected.botID, accountEnabled: selected.enabled, contextGeneration: selected.contextGeneration,
      model: selected.model, repliesEnabled: selected.policy.repliesEnabled } : {}),
    appliesTo: "next-service-start", connectionVerified: false, historyDeleted: false }
}
