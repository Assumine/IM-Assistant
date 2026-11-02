import type { ApplicationModule } from "../../../opencode/packages/plugin/src/promise/application"
import { createResearchModule } from "./module"
import { readConfiguration, settingsOwner } from "./configuration"
import { jsonCollector } from "./http"
import type { Caller, Primitive } from "./contracts"

/** The host approves the origin; model parameters only choose an existing source ID and a relative path. */
export async function configuredResearch(home: string, environment: NodeJS.ProcessEnv = process.env): Promise<ApplicationModule | undefined> {
  const config = await readConfiguration(home)
  if (!config.enabled) return undefined
  const readers = config.sources.map((source) => ({ id: source.id, collector: jsonCollector({ baseURL: source.origin, minimumIntervalMs: source.minimumIntervalMs }) }))
  const primitive: Primitive = { id: "read_json", readOnly: true,
    description: "Read approved JSON sources: " + config.sources.map((source) => source.id + "=" + source.origin).join(", ") + ". Only relative paths, no redirects, credentials or writes.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, source: { type: "string", enum: readers.map((reader) => reader.id) } },
      required: readers.length === 1 ? ["path"] : ["source", "path"], additionalProperties: false }, outputSchema: {},
    execute: async (value, context) => {
      const input = value as { source?: string; path: string }
      const reader = readers.find((reader) => reader.id === input.source) ?? (input.source === undefined && readers.length === 1 ? readers[0] : undefined)
      return reader ? reader.collector.execute({ path: input.path }, context) : { status: "blocked", reason: "approved-source-not-selected" }
    },
  }
  const tokens = new Map<string, Caller>()
  if (config.mcp.enabled) for (const client of config.mcp.clients) {
    const token = environment[client.tokenEnv] ?? ""
    delete environment[client.tokenEnv]
    if (token.length < 24 || token.length > 4096 || /\s/.test(token) || tokens.has(token)) throw new Error("Research MCP credentials are unavailable or duplicated")
    tokens.set(token, { backendID: client.backendID, threadID: client.threadID, ...(client.inputID ? { inputID: client.inputID } : {}) })
  }
  const module = createResearchModule({ primitives: readers.length ? [primitive] : [], scoring: config.scoring })
  return { ...module, settings: settingsOwner(home), open(context) {
    const resource = module.open(context)
    let closed = false, server: ReturnType<typeof Bun.serve> | undefined
    const starting = module.ready.then(() => {
      if (closed || !config.mcp.enabled) return
      try {
        server = Bun.serve({ hostname: "127.0.0.1", port: config.mcp.port,
          fetch: module.mcp(async (token) => tokens.get(token)) })
        context.capability.invalidate?.()
      } catch {
        context.capability.report({ phase: "degraded", message: "Local research MCP could not start. Check its port and client configuration." })
      }
    }).catch(() => {})
    return { ...resource,
      view: async (input) => {
        const view = resource.view ? await resource.view(input) : { title: "Research", items: [] }
        if (!config.mcp.enabled) return view
        return { ...view, description: [view.description, server ? "MCP: http://127.0.0.1:" + server.port + "/mcp" : "MCP: unavailable"].filter(Boolean).join(" · ") }
      },
      async close() { closed = true; server?.stop(true); tokens.clear(); await resource.close(); await starting },
    }
  } }
}
