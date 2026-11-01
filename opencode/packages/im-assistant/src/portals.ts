export * as Portals from "./portals.js"

import path from "node:path"
import { Storage } from "./storage.js"

export function home() {
  return path.join(Storage.root(), "modules", "qq-portal")
}

export async function load() {
  const { configuredModule } = await import("../../../../modules/qq-portal/src/index")
  const module = await configuredModule(home(), process.env, {
    onState: (botID, state) => console.warn(JSON.stringify({ module: "qq-portal", botID, ...state })),
    onIssue: (issue) => console.warn(JSON.stringify({ module: "qq-portal", issue: issue.kind })),
  })
  return module ? [module] : []
}

export async function command(args: readonly string[]) {
  if (
    args.length < 2 ||
    args.length > 3 ||
    args[0] !== "qq" ||
    !["init", "enable", "disable", "status"].includes(args[1]!) ||
    (args[1] === "init" && args.length !== 2)
  )
    throw new Error(
      "Use portal qq init or portal qq enable|disable|status [botID]; changes apply on the next service start",
    )
  const { initialize, readConfiguration, setEnabled, setAccountEnabled } = await import(
    "../../../../modules/qq-portal/src/index"
  )
  if (args[1] === "init") await initialize(home())
  if (args[1] === "enable" || args[1] === "disable") {
    if (args[2] !== undefined) await setAccountEnabled(home(), args[2], args[1] === "enable")
    else await setEnabled(home(), args[1] === "enable")
  }
  const value = await readConfiguration(home())
  const account = args[2] !== undefined ? value.accounts.find((entry) => entry.policy.botID === args[2]) : undefined
  if (args[2] !== undefined && !account) throw new Error("QQ account is not configured")
  return {
    module: "qq-portal",
    enabled: account ? value.enabled && account.enabled !== false : value.enabled,
    ...(account
      ? { botID: account.policy.botID, moduleEnabled: value.enabled, accountEnabled: account.enabled !== false }
      : {}),
    accountCount: value.accounts.length,
    enabledAccountCount: value.enabled ? value.accounts.filter((entry) => entry.enabled !== false).length : 0,
    appliesTo: "next-service-start",
    connectionVerified: false,
    controlRepliesSupported: true,
    automaticTaskReplies: true,
    taskReplyTargets: ["session", "backend"],
  }
}
