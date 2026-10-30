import { expect, test } from "bun:test"
import { Providers } from "./providers.js"

test("catalog discovery uses the API prefix and auth but returns only unique IDs", async () => {
  const calls: { path: string; authorization: string | null }[] = []
  const server = Bun.serve({ port: 0, fetch(request) {
    calls.push({ path: new URL(request.url).pathname, authorization: request.headers.get("Authorization") })
    return Response.json({ data: [{ id: "model-one", cost: 123 }, { id: "model-one" }, { id: "model-two" }, {}, { id: 3 }] })
  } })
  try {
    expect(await Providers.discover({ baseURL: server.url + "v1/", apiKey: "synthetic-private-key" })).toEqual(["model-one", "model-two"])
    expect(calls).toEqual([{ path: "/v1/models", authorization: "Bearer synthetic-private-key" }])
  } finally { await server.stop(true) }
})

test("bad catalogs report a useful error without copying upstream secrets or HTML", async () => {
  for (const [response, expected] of [
    [new Response("private-upstream-detail", { status: 401 }), "HTTP 401"],
    [new Response("<!DOCTYPE html>private-upstream-detail"), "invalid JSON"],
    [Response.json({ models: [] }), "data array"],
  ] as const) {
    const server = Bun.serve({ port: 0, fetch: () => response })
    try {
      const error = await Providers.discover({ baseURL: server.url.toString() }).then(() => "unexpected success", error => String(error))
      expect(error).toContain(expected)
      expect(error).not.toContain("private-upstream-detail")
    } finally { await server.stop(true) }
  }
})

test("discovery never follows redirects with connection credentials", async () => {
  let leaked = false
  const target = Bun.serve({ port: 0, fetch() { leaked = true; return Response.json({ data: [] }) } })
  const server = Bun.serve({ port: 0, fetch: () => Response.redirect(target.url) })
  try {
    await expect(Providers.discover({ baseURL: server.url.toString(), apiKey: "synthetic" })).rejects.toThrow("connection failed")
    expect(leaked).toBe(false)
  } finally { await server.stop(true); await target.stop(true) }
})

test("discovery rejects non-API URLs before issuing a request", async () => {
  for (const baseURL of ["file:///private", "http://user:secret@localhost/v1", "https://example.test/?key=private"])
    await expect(Providers.discover({ baseURL })).rejects.toThrow("HTTP API base URL")
  const failure = await Providers.discover({ baseURL: "private-invalid-address" }).catch(error => String(error))
  expect(failure).toContain("absolute HTTP API base URL")
  expect(failure).not.toContain("private-invalid-address")
})
