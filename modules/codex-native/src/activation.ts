import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { loadProfile } from "./profile"
import { privatePath } from "./permissions"
import { nativeModule } from "./module"

type Activation = { version: 1; enabled: boolean; executable?: string }
const file = (home: string) => path.join(home, "host-activation.json")

/** Host-only local configuration. Absence never creates a profile or opens the native service. */
export async function activation(home: string): Promise<Activation> {
  const content = await readFile(file(home), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (content === undefined) return { version: 1, enabled: false }
  await loadProfile(home)
  await privatePath(file(home), "file")
  const value: unknown = JSON.parse(content)
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some((key) => !["version", "enabled", "executable"].includes(key)) ||
    !("version" in value) || value.version !== 1 || !("enabled" in value) || typeof value.enabled !== "boolean" ||
    ("executable" in value && (typeof value.executable !== "string" || !path.isAbsolute(value.executable))) ||
    (value.enabled && !("executable" in value))) throw new Error("Invalid native host activation configuration")
  return value as Activation
}

/** Changes the next host boot only. Never restarts, kills or reassigns an existing native task. */
export async function setActivation(home: string, enabled: boolean, executable?: string) {
  await loadProfile(home)
  if (enabled && (!executable || !path.isAbsolute(executable))) throw new Error("An absolute native executable is required")
  const existing = await stat(file(home)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (existing) await privatePath(file(home), "file")
  const temporary = path.join(home, `.host-activation-${randomUUID()}`)
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, enabled, ...(enabled ? { executable } : {}) }) + "\n", { flag: "wx", mode: 0o600 })
    await rename(temporary, file(home))
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error })
  }
}

export async function configuredModule(home: string) {
  const value = await activation(home)
  if (!value.enabled) return undefined
  return nativeModule({ executable: value.executable!, profile: await loadProfile(home) })
}
