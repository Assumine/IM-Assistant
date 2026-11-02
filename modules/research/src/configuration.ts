import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { Flock } from "../../../opencode/packages/util/src/flock"
import type { ApplicationModuleSettings } from "../../../opencode/packages/plugin/src/promise/application"
import { resolveScoring } from "./dispatcher"
import type { Scoring } from "./types"

const identifier = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/))
const Client = Schema.Struct({ tokenEnv: Schema.String.check(Schema.isPattern(/^IM_RESEARCH_MCP_TOKEN_[A-Z0-9_]{1,64}$/)),
  backendID: identifier, threadID: identifier, inputID: Schema.optional(identifier) })
const Configuration = Schema.Struct({ version: Schema.Literal(1), enabled: Schema.Boolean,
  sources: Schema.mutable(Schema.Array(Schema.Struct({ id: identifier, origin: Schema.String,
    minimumIntervalMs: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(5000))) })).check(Schema.isMaxLength(16))),
  mcp: Schema.Struct({ enabled: Schema.Boolean, port: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })),
    clients: Schema.mutable(Schema.Array(Client).check(Schema.isMaxLength(16))) }),
  scoring: Schema.optional(Schema.Struct({ initial: Schema.Number, failurePenalty: Schema.Number,
    successReward: Schema.Number, historicalFailurePenalty: Schema.Number })),
})
export type ResearchConfiguration = typeof Configuration.Type
const empty = (): ResearchConfiguration => ({ version: 1, enabled: false, sources: [], mcp: { enabled: false, port: 0, clients: [] } })
const serialize = (value: ResearchConfiguration) => JSON.stringify(value, null, 2) + "\n"
const revision = (text: string) => createHash("sha256").update(text).digest("hex")

/** Declarative approvals only: no executable paths, credentials, model selection or independent sessions. */
export function configuration(value: unknown): ResearchConfiguration {
  const result = Schema.decodeUnknownSync(Configuration)(value, { onExcessProperty: "error" })
  if (new Set(result.sources.map((source) => source.id)).size !== result.sources.length ||
    new Set(result.mcp.clients.map((client) => client.tokenEnv)).size !== result.mcp.clients.length) throw new Error("Duplicate research configuration identity")
  const origins = new Set<string>()
  for (const source of result.sources) {
    const url = new URL(source.origin)
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) || origins.has(url.origin))
      throw new Error("Invalid approved research source")
    origins.add(url.origin)
  }
  if (result.mcp.enabled && result.mcp.clients.length === 0) throw new Error("Configure authenticated MCP clients before enabling the endpoint")
  if (result.mcp.clients.some((client) => client.inputID && client.backendID !== "opencode"))
    throw new Error("External research execution needs a host-bound native cancellation adapter; static settings allow authoring only")
  if (result.scoring) resolveScoring(result.scoring as Scoring)
  return { ...result, sources: result.sources.map((source) => ({ ...source, origin: new URL(source.origin).origin })) }
}

export async function readConfiguration(home: string): Promise<ResearchConfiguration> {
  try {
    const file = path.join(home, "research.json"), stat = await lstat(file)
    if (!stat.isFile() || stat.size > 65536) throw new Error("Invalid research configuration file")
    const handle = await open(file, "r")
    try {
      const bytes = Buffer.alloc(65537), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
      if (bytesRead > 65536) throw new Error("Research settings exceed the size limit")
      return configuration(JSON.parse(bytes.toString("utf8", 0, bytesRead)))
    } finally { await handle.close() }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return empty()
    throw new Error("Research configuration is unavailable; check the module settings")
  }
}

export function settingsOwner(home: string): ApplicationModuleSettings {
  const describe = (value: ResearchConfiguration) => ({ revision: revision(serialize(value)), text: serialize(value), appliesTo: "next-service-start" as const,
    description: "Approved JSON origins, per-origin intervals (at least 5 seconds), optional scores and local MCP client references. Tokens stay in environment variables. Saving does not start tasks or change running services." })
  return {
    async read(signal) { signal.throwIfAborted(); return describe(await readConfiguration(home)) },
    async write(input, signal) {
      if (Buffer.byteLength(input.text, "utf8") > 65536) throw new Error("Research settings exceed the size limit")
      const desired = configuration(JSON.parse(input.text))
      await mkdir(home, { recursive: true })
      return Flock.withLock("research-settings", async () => {
        const previous = await readConfiguration(home)
        if (revision(serialize(previous)) !== input.revision) return undefined
        signal.throwIfAborted()
        const temporary = path.join(home, ".research-" + randomUUID() + ".json"), file = await open(temporary, "wx", 0o600)
        try { await file.writeFile(serialize(desired)); await file.close(); await rename(temporary, path.join(home, "research.json")) }
        finally { await file.close(); await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error }) }
        return describe(desired)
      }, { dir: path.join(home, ".locks"), signal, timeoutMs: 2000 })
    },
  }
}

export async function initializeConfiguration(home: string) {
  await mkdir(home, { recursive: true })
  const file = await open(path.join(home, "research.json"), "wx", 0o600)
  try { await file.writeFile(serialize(empty())) } finally { await file.close() }
}
