export * as Backends from "./backends.js"

import path from "node:path"
import { Storage } from "./storage.js"

// Product composition knows its installed capability. Core/Server only receive the public Module contract.
export function home() {
  return path.join(Storage.root(), "modules", "codex-native")
}

export async function load() {
  const { configuredModule } = await import("../../../../modules/codex-native/src/index")
  const module = await configuredModule(home())
  return module ? [module] : []
}

export async function command(args: readonly string[]) {
  if (args.length !== 2 || args[0] !== "codex" || !["init", "enable", "disable", "status"].includes(args[1]!))
    throw new Error("Use backend codex init|enable|disable|status; changes apply on the next service start")
  const { activation, createSharedProfile, setActivation } = await import("../../../../modules/codex-native/src/index")
  if (args[1] === "init") await createSharedProfile(home())
  if (args[1] === "enable") {
    const executable = Bun.which("codex")
    if (!executable) throw new Error("Install the verified Codex CLI before enabling this backend")
    await setActivation(home(), true, executable)
  }
  if (args[1] === "disable" && (await activation(home())).enabled) await setActivation(home(), false)
  const value = await activation(home())
  return {
    backendID: "codex-native",
    enabled: value.enabled,
    appliesTo: "next-service-start",
    connectionVerified: false,
  }
}
