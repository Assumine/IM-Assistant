export * as Providers from "./providers.js"

// Catalog discovery does not select a model, move queued inputs or claim that generation works.
export async function discover(input: { baseURL: string; apiKey?: string }) {
  const url = (() => {
    try { return new URL(input.baseURL) }
    catch { throw new Error("Expected an absolute HTTP API base URL") }
  })()
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("Expected an HTTP API base URL without credentials, query or fragment")
  url.pathname = url.pathname.replace(/\/$/, "") + "/models"
  const response = await fetch(url, {
    headers: input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {},
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => { throw new Error("Model catalog connection failed; check the API base URL and connection") })
  if (!response.ok) throw new Error(`Model catalog request failed (HTTP ${response.status})`)
  const body: unknown = await response.json().catch(() => {
    throw new Error("Model catalog returned invalid JSON; check that the URL points to the API, not its website")
  })
  if (!body || typeof body !== "object" || !("data" in body) || !Array.isArray(body.data))
    throw new Error("Model catalog must contain a data array")
  return [...new Set(body.data.flatMap((item: unknown) => {
    if (!item || typeof item !== "object" || !("id" in item) || typeof item.id !== "string" || !item.id.trim()) return []
    return [item.id]
  }))]
}

export async function command() {
  const input: unknown = await Bun.stdin.json().catch(() => { throw new Error("Expected JSON API connection on stdin") })
  if (!input || typeof input !== "object" || !("baseURL" in input) || typeof input.baseURL !== "string" ||
    ("apiKey" in input && input.apiKey !== undefined && typeof input.apiKey !== "string"))
    throw new Error("Expected baseURL and an optional apiKey on stdin")
  const models = await discover({ baseURL: input.baseURL, apiKey: "apiKey" in input ? input.apiKey as string | undefined : undefined })
  // No key, upstream body, pricing or guessed context limit appears in output.
  return { models, generationVerified: false }
}
