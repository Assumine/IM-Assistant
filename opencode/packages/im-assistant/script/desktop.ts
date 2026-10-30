// Development entry for the original compiled Electron app. Packaging belongs to the later release phase.
import { existsSync } from "node:fs"
import path from "node:path"

const desktop = path.resolve(import.meta.dirname, "../../desktop")
if (!existsSync(path.join(desktop, "out/main/index.js")))
  throw new Error("Build packages/desktop with bun x electron-vite build first")
const { default: electron } = await import(Bun.resolveSync("electron", desktop))
const version = (await Bun.file(path.resolve(import.meta.dirname, "../../../package.json")).json()).version
process.exitCode = await Bun.spawn([electron, desktop, ...process.argv.slice(2)], {
  env: { ...process.env, IM_ASSISTANT_PROFILE: "personal", OPENCODE_DESKTOP_ISOLATED_SERVER: "0",
    PATH: [path.dirname(process.execPath), process.env.PATH ?? ""].join(path.delimiter),
    OPENCODE_DESKTOP_CLI_DEV: path.resolve(desktop, "../cli"), OPENCODE_VERSION: version },
  stdio: ["inherit", "inherit", "inherit"],
}).exited
