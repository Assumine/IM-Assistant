import { createHash, randomBytes } from "node:crypto"
import { createServer } from "node:net"
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import path from "node:path"

export const verifiedVersion = "codex-cli 0.166.0-alpha.5.1"

// A dedicated native home, not a copy of the user's existing Codex profile.
export interface Profile {
  home: string
  workspace: string
  keyName?: string
  service?: { port: number; tokenFile: string; tokenHash: string }
}

export interface Connection {
  id: string
  model: string
  baseURL: string
  keyName: string
}

const disabled = [
  "shell_tool", "unified_exec", "view_image", "multi_agent", "code_mode", "code_mode_host",
  "browser_use", "computer_use", "plugins", "apps", "hooks", "image_generation", "shell_snapshot",
  "workspace_dependencies", "skill_search", "tool_suggest", "sleep_tool", "goals", "remote_plugin",
] as const

export const policy = {
  approval_policy: '"never"',
  sandbox_mode: '"read-only"',
  project_doc_max_bytes: "0",
  web_search: '"disabled"',
  "agents.enabled": "false",
  "tools.update_plan.enabled": "false",
  "features.skip_host_skill_discovery": "true",
  ...Object.fromEntries(disabled.map((key) => [`features.${key}`, "false"])),
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex")
const marker = ".im-assistant-profile.json"

export async function createProfile(root: string, connection?: Connection): Promise<Profile> {
  return create(root, connection, false)
}
export async function createSharedProfile(root: string, connection?: Connection): Promise<Profile> {
  return create(root, connection, true)
}
async function create(root: string, connection: Connection | undefined, shared: boolean): Promise<Profile> {
  if (!path.isAbsolute(root)) throw new Error("Profile path must be absolute")
  if (connection) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(connection.id) || !/^IM_[A-Z0-9_]{1,60}$/.test(connection.keyName)) {
      throw new Error("Invalid connection identifier")
    }
    if (!connection.model.trim() || /[\r\n\0]/.test(connection.model)) throw new Error("Invalid model")
    const url = new URL(connection.baseURL)
    if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
      throw new Error("Connection requires HTTPS or local fixture URL")
    }
  }
  await mkdir(root, { recursive: true })
  if ((await readdir(root)).length) throw new Error("Refusing to adopt an existing profile")
  const home = await realpath(root)
  const workspace = path.join(home, "workspace")
  await mkdir(workspace)
  const lines = [
    'approval_policy = "never"', 'sandbox_mode = "read-only"', 'project_doc_max_bytes = 0',
    'web_search = "disabled"',
    ...Object.entries(policy).filter(([key]) => key.includes(".")).map(([key, value]) => `${key} = ${value}`),
  ]
  if (connection) {
    lines.push(`model = ${JSON.stringify(connection.model)}`, `model_provider = ${JSON.stringify(connection.id)}`,
      `[model_providers.${connection.id}]`, `name = ${JSON.stringify(connection.id)}`,
      `base_url = ${JSON.stringify(connection.baseURL)}`, 'wire_api = "responses"',
      `env_key = ${JSON.stringify(connection.keyName)}`, 'requires_openai_auth = false', 'supports_websockets = false')
  }
  const config = lines.join("\n") + "\n"
  await writeFile(path.join(home, "config.toml"), config, { flag: "wx" })
  const profile: Profile = { home, workspace, keyName: connection?.keyName }
  if (shared) {
    const reservation = createServer()
    await new Promise<void>((resolve, reject) => {
      reservation.once("error", reject)
      reservation.listen(0, "127.0.0.1", resolve)
    })
    const port = (reservation.address() as { port: number }).port
    await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()))
    const token = randomBytes(32).toString("hex")
    const tokenFile = path.join(home, "app-server-token")
    await writeFile(tokenFile, token, { flag: "wx", mode: 0o600 })
    profile.service = { port, tokenFile, tokenHash: digest(token) }
  }
  await writeFile(path.join(home, marker), JSON.stringify({ ...profile, configHash: digest(config), version: verifiedVersion }), { flag: "wx" })
  return profile
}

export async function loadProfile(root: string): Promise<Profile> {
  const stored = JSON.parse(await readFile(path.join(root, marker), "utf8"))
  const profile: Profile = { home: stored.home, workspace: stored.workspace, keyName: stored.keyName, service: stored.service }
  if (path.resolve(root) !== profile.home) throw new Error("Managed profile path changed")
  await verifyProfile(profile)
  return profile
}

export async function verifyProfile(profile: Profile) {
  const home = await realpath(profile.home)
  if (home !== profile.home || await realpath(profile.workspace) !== path.join(home, "workspace")) {
    throw new Error("Profile workspace must remain inside its managed home")
  }
  const stored = JSON.parse(await readFile(path.join(home, marker), "utf8"))
  const config = await readFile(path.join(home, "config.toml"), "utf8")
  if (stored.home !== home || stored.workspace !== profile.workspace || stored.keyName !== profile.keyName ||
    stored.version !== verifiedVersion || stored.configHash !== digest(config) || JSON.stringify(stored.service) !== JSON.stringify(profile.service)) {
    throw new Error("Managed profile changed; revalidation required")
  }
  if (profile.service) {
    const service = profile.service
    if (!Number.isInteger(service.port) || service.port < 1 || service.port > 65535 ||
      service.tokenFile !== path.join(home, "app-server-token") || await realpath(service.tokenFile) !== service.tokenFile ||
      digest(await readFile(service.tokenFile, "utf8")) !== service.tokenHash) {
      throw new Error("Managed service connection changed; revalidation required")
    }
  }
}
