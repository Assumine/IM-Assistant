import { createMcpHandler, Server } from "@modelcontextprotocol/server"
import type { ListToolsResult } from "@modelcontextprotocol/server"
import type { Identity } from "./contracts"
import { researchService } from "./service"

/** Host-owned local HTTP endpoint. Authorization resolves a conversation; model arguments never select their identity. */
export function createResearchMcp(options: {
  service: ReturnType<typeof researchService>
  authenticate: (token: string) => Promise<Identity | undefined>
}) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      request.headers.has("origin") && request.headers.get("origin") !== url.origin) return new Response("Forbidden", { status: 403 })
    const token = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1]
    const actor = token ? await options.authenticate(token).catch(() => undefined) : undefined
    if (!actor) return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer" } })
    // A fresh SDK server per request prevents cross-client protocol/session ownership leaks.
    const handler = createMcpHandler(() => {
      const server = new Server({ name: "im-assistant-research", version: "0.0.0" },
        { capabilities: { tools: {}, resources: {} }, instructions: "Read research_identity. Adopt the role to explore, author, test and publish collection functions. Other callers can read and execute published paths." })
      server.setRequestHandler("tools/list", async () => JSON.parse(JSON.stringify({ tools: options.service.definitions.map((item) => ({ name: "research_" + item.name, description: item.description, inputSchema: item.input })) })) as ListToolsResult)
      server.setRequestHandler("tools/call", async (input) => {
        if (!input.params.name.startsWith("research_")) return { content: [{ type: "text", text: "Unknown research tool" }], isError: true }
        const result = await options.service.call(actor, input.params.name.replace(/^research_/, ""), input.params.arguments ?? {}, request.signal)
        return { content: [{ type: "text", text: JSON.stringify(result) }],
          ...(result !== null && typeof result === "object" && "status" in result && result.status === "error" ? { isError: true } : {}) }
      })
      server.setRequestHandler("resources/list", async () => ({ resources: [
        { uri: "research://identity", name: "Research assistance identity", mimeType: "application/json" },
        { uri: "research://paths", name: "Shared research paths and requests", mimeType: "application/json" },
      ] }))
      server.setRequestHandler("resources/read", async (input) => {
        const name = input.params.uri === "research://identity" ? "identity" : input.params.uri === "research://paths" ? "paths" : undefined
        if (!name) throw new Error("Unknown research resource")
        const value = await options.service.call(actor, name, {}, request.signal)
        return { contents: [{ uri: input.params.uri, mimeType: "application/json", text: JSON.stringify(value) }] }
      })
      return server
    })
    return handler.fetch(request)
  }
}
