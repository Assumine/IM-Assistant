// Development entry for the original compiled Electron app. Packaging belongs to the later release phase.
import { existsSync, realpathSync } from "node:fs"
import path from "node:path"

const desktop = path.resolve(import.meta.dirname, "../../desktop")
const app = process.env.IM_ASSISTANT_DESKTOP_RELEASE ? realpathSync(process.env.IM_ASSISTANT_DESKTOP_RELEASE) : desktop
if (app !== desktop) {
  const releases = realpathSync(path.join(desktop, ".im-releases"))
  if (path.dirname(app) !== releases || !/^[a-f0-9]{64}$/.test(path.basename(app)))
    throw new Error("Invalid desktop release location")
}
if (!existsSync(path.join(app, "out/main/index.js")))
  throw new Error("Build packages/desktop with bun x electron-vite build first")
const { default: electron } = await import(Bun.resolveSync("electron", desktop))
const version = (await Bun.file(path.resolve(import.meta.dirname, "../../../package.json")).json()).version
process.exitCode = await Bun.spawn([electron, app, ...process.argv.slice(2)], {
  env: {
    ...process.env,
    IM_ASSISTANT_PROFILE: "personal",
    OPENCODE_DESKTOP_ISOLATED_SERVER: "0",
    PATH: [path.dirname(process.execPath), process.env.PATH ?? ""].join(path.delimiter),
    OPENCODE_DESKTOP_CLI_DEV: path.resolve(desktop, "../cli"),
    OPENCODE_VERSION: version,
  },
  stdio: ["inherit", "inherit", "inherit"],
}).exited
