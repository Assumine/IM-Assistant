// This is a profile bootstrap for the original CLI, not another host or execution loop.
import { Storage } from "./storage.js"
import path from "node:path"

process.env.IM_ASSISTANT_PROFILE = "personal"
Storage.prepare()
// Preserve the original CLI's Solid preload even when invoked from the product package directory.
await import(Bun.resolveSync("@opentui/solid/preload", path.resolve(import.meta.dirname, "../../cli")))
await import(path.resolve(import.meta.dirname, "../../cli/src/index.ts"))
