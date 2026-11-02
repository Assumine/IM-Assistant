import type { StorageDomain } from "../../../opencode/packages/plugin/src/promise/storage"
import type { Data, Draft, Identity, Primitive } from "../src/index"

export const first: Identity = { backendID: "opencode", threadID: "ses_research_a" }
export const second: Identity = { backendID: "codex", threadID: "thread_research_b" }
export const schema = { type: "object", properties: { title: { type: "string" } }, required: ["title"] }
export const source: Primitive = { id: "read_page", description: "Read synthetic page content", inputSchema: schema, outputSchema: schema,
  execute: async (input) => ({ status: "success", value: input }) }
export const definition: Draft = { id: "movie-details", revision: "1", category: "film", action: "details", title: "Read movie details",
  tools: ["read_page"], inputSchema: schema, outputSchema: schema, program: "return await tools.read_page(input)" }
export const request = { roundID: "round", category: "film", action: "details", input: { title: "Synthetic movie" } }
export function memory(): StorageDomain {
  const entries = new Map<string, Data>()
  return {
    get: async (key) => structuredClone(entries.get(key)),
    set: async (key, value) => { entries.set(key, structuredClone(value)) },
    insert: async (key, value) => { if (entries.has(key)) return false; entries.set(key, structuredClone(value)); return true },
    remove: async (key) => { entries.delete(key) },
    scan: async ({ prefix, after, limit = 100 }) => {
      const all = [...entries.keys()].filter((key) => key.startsWith(prefix) && (after === undefined || key > after)).sort(), page = all.slice(0, limit)
      return { entries: page.map((key) => ({ key, value: structuredClone(entries.get(key)!) })), ...(all.length > page.length ? { next: page.at(-1) } : {}) }
    },
  }
}
