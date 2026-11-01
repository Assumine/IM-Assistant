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
  if (args.length !== 2 || args[0] !== "qq" || !["init", "enable", "disable", "status"].includes(args[1]!))
    throw new Error("Use portal qq init|enable|disable|status; changes apply on the next service start")
  const { initialize, readConfiguration, setEnabled } = await import("../../../../modules/qq-portal/src/index")
  if (args[1] === "init") await initialize(home())
  if (args[1] === "enable" || args[1] === "disable") await setEnabled(home(), args[1] === "enable")
  const value = await readConfiguration(home())
  return {
    module: "qq-portal",
    enabled: value.enabled,
    accountCount: value.accounts.length,
    appliesTo: "next-service-start",
    connectionVerified: false,
    controlRepliesSupported: true,
    automaticTaskReplies: true,
    taskReplyTargets: ["session"],
  }
}
