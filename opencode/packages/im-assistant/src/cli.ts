// This is a profile bootstrap for the original CLI, not another host or execution loop.
import { Storage } from "./storage.js"
import { Policy } from "./policy.js"
import path from "node:path"

process.env.IM_ASSISTANT_PROFILE = "personal"
Storage.prepare()
if (process.argv[2] === "backend") {
  const { Backends } = await import("./backends.js")
  try {
    console.log(JSON.stringify(await Backends.command(process.argv.slice(3))))
  } catch {
    console.error(
      "Backend configuration failed; use backend codex init|enable|disable|status and check the dedicated profile/verified CLI",
    )
    process.exitCode = 1
  }
} else if (process.argv[2] === "portal") {
  const { Portals } = await import("./portals.js")
  try {
    console.log(JSON.stringify(await Portals.command(process.argv.slice(3))))
  } catch {
    console.error(
      "QQ configuration failed; use portal qq init|enable|disable|status. Control and native Session replies are supported; whole-backend task replies are not connected yet.",
    )
    process.exitCode = 1
  }
} else if (process.argv[2] === "models" && process.argv.length === 3) {
  const { Providers } = await import("./providers.js")
  try {
    console.log(JSON.stringify(await Providers.command()))
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Model catalog query failed")
    process.exitCode = 1
  }
} else {
  if (!Policy.allowsCLI(process.argv.slice(2)))
    throw new Error("This entry supports the managed conversation service only")
  // Preserve the original CLI's Solid preload even when invoked from the product package directory.
  await import(Bun.resolveSync("@opentui/solid/preload", path.resolve(import.meta.dirname, "../../cli")))
  await import(path.resolve(import.meta.dirname, "../../cli/src/index.ts"))
}
