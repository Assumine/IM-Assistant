// This is a profile bootstrap for the original CLI, not another host or execution loop.
import { Storage } from "./storage.js"
import { Policy } from "./policy.js"
import path from "node:path"

process.env.IM_ASSISTANT_PROFILE = "personal"
Storage.prepare()
if (!Policy.allowsCLI(process.argv.slice(2))) throw new Error("This entry supports the managed conversation service only")
// Preserve the original CLI's Solid preload even when invoked from the product package directory.
await import(Bun.resolveSync("@opentui/solid/preload", path.resolve(import.meta.dirname, "../../cli")))
await import(path.resolve(import.meta.dirname, "../../cli/src/index.ts"))
