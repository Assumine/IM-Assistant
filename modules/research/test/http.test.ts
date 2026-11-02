import { expect, test } from "bun:test"
import { jsonCollector } from "../src/index"

test("a verified HTTP 404 is a successful negative finding", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("Absent", { status: 404 }) })
  try {
    const collector = jsonCollector({ baseURL: `http://127.0.0.1:${server.port}`, minimumIntervalMs: 0 })
    expect(await collector.execute({ path: "/movie" }, { signal: new AbortController().signal })).toMatchObject({ status: "success", value: { found: false } })
  } finally { server.stop(true) }
})

test("collector parameters cannot change the approved origin or introduce credentials", async () => {
  let calls = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { calls++; return Response.json({}) } })
  try {
    const collector = jsonCollector({ baseURL: `http://127.0.0.1:${server.port}`, minimumIntervalMs: 0 })
    for (const path of ["https://unapproved.invalid/data", "//unapproved.invalid/data", `http://user:secret@127.0.0.1:${server.port}/data`])
      expect(await collector.execute({ path }, { signal: new AbortController().signal })).toMatchObject({ status: "blocked" })
    expect(calls).toBe(0)
  } finally { server.stop(true) }
})

test("HTML or login barriers and redirects stop instead of being parsed as JSON or followed", async () => {
  let calls = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    calls++
    return new URL(request.url).pathname === "/redirect" ? new Response(null, { status: 302, headers: { location: "https://unapproved.invalid" } })
      : new Response("<!DOCTYPE html><title>Login required</title>", { headers: { "content-type": "text/html" } })
  } })
  try {
    const collector = jsonCollector({ baseURL: `http://127.0.0.1:${server.port}`, minimumIntervalMs: 0 })
    for (const path of ["/login", "/redirect"]) expect(await collector.execute({ path }, { signal: new AbortController().signal })).toMatchObject({ status: "blocked" })
    expect(calls).toBe(2)
  } finally { server.stop(true) }
})

test("cancelling a rate-limited read prevents its future request without background polling", async () => {
  let calls = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { calls++; return Response.json({}) } })
  try {
    const collector = jsonCollector({ baseURL: `http://127.0.0.1:${server.port}`, minimumIntervalMs: 100000 })
    await collector.execute({ path: "/first" }, { signal: new AbortController().signal })
    const controller = new AbortController(), queuedRead = collector.execute({ path: "/next" }, { signal: controller.signal })
    controller.abort()
    await expect(queuedRead).rejects.toThrow("cancelled")
    expect(calls).toBe(1)
  } finally { server.stop(true) }
})
