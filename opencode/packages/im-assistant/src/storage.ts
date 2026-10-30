export * as Storage from "./storage.js"

import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { Profile } from "./profile.js"

export function root(appData = process.env.APPDATA ?? (process.platform === "darwin"
  ? path.join(homedir(), "Library/Application Support")
  : process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"))) {
  const selected = process.env.IM_ASSISTANT_DATA_ROOT ?? path.join(appData, Profile.id)
  if (!path.isAbsolute(selected)) throw new Error("IM_ASSISTANT_DATA_ROOT must be absolute")
  return path.resolve(selected)
}

export function paths(directory: string) {
  return {
    root: directory,
    desktop: path.join(directory, "desktop"),
    session: path.join(directory, "session"),
    location: path.join(directory, "session-location"),
    data: path.join(directory, "native/data"),
    cache: path.join(directory, "native/cache"),
    config: path.join(directory, "native/config"),
    state: path.join(directory, "native/state"),
    tmp: path.join(directory, "tmp"),
    database: path.join(directory, "native/data/opencode/opencode.db"),
    nativeConfig: path.join(directory, "native/config/opencode"),
    registration: path.join(directory, "native/state/opencode", Profile.serviceFile),
  }
}

export function prepare(appData?: string) {
  const selected = paths(root(appData))
  for (const directory of [selected.desktop, selected.session, selected.location, selected.data,
    selected.cache, selected.nativeConfig, selected.state, selected.tmp]) mkdirSync(directory, { recursive: true })

  createOnce(path.join(selected.nativeConfig, Profile.serviceFile), { hostname: "127.0.0.1", port: Profile.servicePort })
  createOnce(path.join(selected.nativeConfig, "opencode.json"), { update: "disable", share: "disabled" })

  // An installed OpenCode/old development launcher must not redirect this profile into another DB or credential file.
  for (const key of ["OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD",
    "OPENCODE_DESKTOP_TEST_ROOT", "OPENCODE_TEST_ONBOARDING", "OPENCODE_TEST_HOME"]) delete process.env[key]
  Object.assign(process.env, {
    IM_ASSISTANT_DATA_ROOT: selected.root,
    XDG_DATA_HOME: selected.data, XDG_CACHE_HOME: selected.cache,
    XDG_CONFIG_HOME: selected.config, XDG_STATE_HOME: selected.state,
    TMP: selected.tmp, TEMP: selected.tmp, TMPDIR: selected.tmp,
    OPENCODE_CONFIG_DIR: selected.nativeConfig, OPENCODE_DB: selected.database,
    OPENCODE_CONFIG_PROJECT_DISABLE: "true", OPENCODE_DISABLE_CLAUDE_CODE: "true",
    OPENCODE_DESKTOP_ISOLATED_SERVER: "0",
  })
  return selected
}

function createOnce(file: string, value: unknown) {
  const descriptor = (() => {
    try {
      return openSync(file, "wx", 0o600)
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") return undefined
      throw error
    }
  })()
  if (descriptor === undefined) return
  try {
    writeFileSync(descriptor, JSON.stringify(value, null, 2) + "\n")
  } finally {
    closeSync(descriptor)
  }
}
