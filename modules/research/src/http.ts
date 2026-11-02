import type { Primitive } from "./contracts"
import type { Data } from "./types"

/** Read-only adapter for one host-approved origin. Browser/session collection is a separate adapter. */
export function jsonCollector(options: { baseURL: string; minimumIntervalMs?: number }): Primitive {
  const base = new URL(options.baseURL), interval = options.minimumIntervalMs ?? 5000
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || !Number.isFinite(interval) || interval < 0)
    throw new Error("Invalid approved collector origin")
  let next = 0
  return {
    id: "read_json", description: "GET JSON from the configured source origin. Input path is relative; no arbitrary host, credentials, writes or redirect following. Verified 404 is a successful negative finding.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false }, outputSchema: {},
    async execute(input, { signal }) {
      const request = input as { path: string }, url = new URL(request.path, base)
      if (url.origin !== base.origin || url.username || url.password) return { status: "blocked", reason: "source-origin-not-approved" }
      const now = Date.now(), wait = Math.max(0, next - now)
      next = Math.max(now, next) + interval
      if (signal.aborted) return { status: "uncertain", reason: "research-cancelled" }
      if (wait > 0) await new Promise<void>((resolve, reject) => {
        const done = () => { signal.removeEventListener("abort", cancel); resolve() }
        const timer = setTimeout(done, wait)
        const cancel = () => { clearTimeout(timer); reject(new Error("Collector cancelled")) }
        signal.addEventListener("abort", cancel, { once: true })
      })
      try {
        const response = await fetch(url, { method: "GET", redirect: "manual", signal })
        if (response.status === 404) { await response.body?.cancel(); return { status: "success", value: { found: false, status: 404, url: url.href } } }
        if (response.status >= 500) { await response.body?.cancel(); return { status: "failure", reason: "read-only-source-temporarily-failed" } }
        if (!response.ok || !response.headers.get("content-type")?.match(/\bjson\b/)) {
          await response.body?.cancel()
          return { status: "blocked", reason: "source-requires-access-or-page-review: " + url.href }
        }
        return { status: "success", value: await response.json() as Data }
      } catch { return { status: "uncertain", reason: signal.aborted ? "research-cancelled" : "source-response-unknown" } }
    },
  }
}
