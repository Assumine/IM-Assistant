// Real product bootstrap acceptance. No production profile, credentials or existing service is touched.
import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { Admission, Created } from "@opencode/schema/conversation-backend"
import { Backends } from "../../im-assistant/src/backends"
import {
  CodexSessionAdapter,
  createSharedProfile,
  loadProfile,
  setActivation,
  stopSharedService,
} from "../../../../modules/codex-native/src"

const executable = process.env.IM_CODEX_EXECUTABLE
const root = process.env.IM_CODEX_TEST_ROOT
if (!executable || !root) throw new Error("Use the isolated R3 acceptance runner")
const base = await mkdtemp(path.join(root, "product-entry-"))
const product = path.join(base, "product")
const entry = path.resolve(import.meta.dirname, "../../im-assistant/src/cli.ts")
process.env.IM_ASSISTANT_DATA_ROOT = product
const checks: string[] = []
const requests: unknown[] = []
const entered = Promise.withResolvers<void>()
const release = Promise.withResolvers<void>()
const completed = Promise.withResolvers<void>()
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method !== "POST") return Response.json({ data: [] })
    requests.push(await request.json())
    entered.resolve()
    await release.promise
    const item = {
      id: "msg_product",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "product-reply", annotations: [] }],
    }
    const events = [
      { type: "response.created", response: { id: "resp_product", status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: {
          id: "resp_product",
          status: "completed",
          output: [item],
          usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
        },
      },
    ]
    return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    })
  },
})

function env(directory: string) {
  return { ...process.env, IM_ASSISTANT_DATA_ROOT: directory, OPENCODE_DISABLE_MODELS_FETCH: "true" }
}

async function command(directory: string, action: string, success = true) {
  const child = Bun.spawn([process.execPath, "run", entry, "backend", "codex", action], {
    env: env(directory),
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const [code, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  assert.equal(code === 0, success, error)
  if (!success) return undefined
  return JSON.parse(output) as { enabled: boolean; connectionVerified: boolean; appliesTo: string }
}

async function boot(directory = product) {
  const child = Bun.spawn([process.execPath, "run", entry, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    env: env(directory),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const ready = Promise.withResolvers<void>()
  let url: string | undefined
  let password: string | undefined
  const reading = (async () => {
    const decoder = new TextDecoder()
    let buffer = ""
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        if (line.startsWith("server listening on ")) url = line.slice("server listening on ".length).trim()
        if (line.startsWith("server password ")) password = line.slice("server password ".length).trim()
        if (url && password) ready.resolve()
      }
    }
  })()
  const errors = new Response(child.stderr).text()
  const timer = setTimeout(() => ready.reject(new Error("Product startup deadline")), 30_000)
  const exited = child.exited.then(() => ready.reject(new Error("Product exited before startup")))
  const stop = async () => {
    child.kill()
    await Promise.all([child.exited, reading, errors, exited])
  }
  try {
    await ready.promise
  } catch (error) {
    await stop()
    throw error
  } finally {
    clearTimeout(timer)
  }
  const request = async (route: string, input?: unknown) => {
    const target = new URL(route, url)
    target.searchParams.set("location[directory]", path.join(directory, "session-location"))
    const response = await fetch(target, {
      method: input === undefined ? "GET" : "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
        "content-type": "application/json",
      },
      ...(input === undefined ? {} : { body: JSON.stringify({ input }) }),
      signal: AbortSignal.timeout(15_000),
    })
    assert.equal(response.status, 200, `Product route failed: ${route}`)
    return (await response.json()) as { output: unknown; data: unknown[] }
  }
  return {
    stop,
    request,
    call: async (method: string, input: unknown = {}) =>
      (await request(`/api/rpc/experimental.conversation/${method}`, input)).output,
  }
}

const initialized = path.join(base, "initialization")
assert.equal((await command(initialized, "status"))?.enabled, false)
assert.equal((await command(initialized, "init"))?.enabled, false)
await command(initialized, "init", false)
await command(initialized, "disable")
checks.push("product CLI initializes only a dedicated profile, refuses adoption and remains disabled by default")

await command(initialized, "enable")
const coldProfile = await loadProfile(path.join(initialized, "modules", "codex-native"))
let coldHost: Awaited<ReturnType<typeof boot>> | undefined
try {
  coldHost = await boot(initialized)
  const deadline = Date.now() + 20_000
  while (((await coldHost.call("list")) as unknown[]).length === 0 && Date.now() < deadline) await Bun.sleep(20)
  assert.deepEqual(await coldHost.call("status", { backendID: "codex-native" }), {
    authentication: { state: "signed-out" },
  })
  assert.deepEqual((await coldHost.request("/api/session")).data, [])
  checks.push(
    "a fresh product boot starts its own isolated native service and reports signed-out without adopting an existing account",
  )
} finally {
  await coldHost?.stop()
  await stopSharedService({ executable, profile: coldProfile })
}

const profile = await createSharedProfile(Backends.home(), {
  id: "fixture",
  model: "local-fixture",
  baseURL: `http://127.0.0.1:${upstream.port}/v1`,
  keyName: "IM_FIXTURE_KEY",
})
// The owned synthetic provider's key belongs to the native service. The product does not copy it into host configuration.
const options = { executable, profile, apiKey: "fixture-only" }
const observer = await CodexSessionAdapter.open(options)
observer.subscribe((event) => {
  if (event.method === "turn/completed") completed.resolve()
})
const nativePID = observer.runtimeInfo().pid
let host: Awaited<ReturnType<typeof boot>> | undefined
try {
  host = await boot()
  assert.deepEqual(await host.call("list"), [])
  assert.deepEqual((await host.request("/api/session")).data, [])
  assert.equal((await command(product, "enable"))?.appliesTo, "next-service-start")
  assert.deepEqual(await host.call("list"), [])
  checks.push("enabling changes the next product boot without replacing the current service or its core sessions")
  await host.stop()
  host = await boot()
  const deadline = Date.now() + 20_000
  while (((await host.call("list")) as unknown[]).length === 0 && Date.now() < deadline) await Bun.sleep(20)
  assert.deepEqual(await host.call("list"), [
    { id: "codex-native", label: "Codex", browse: true, execution: true, create: true, images: true },
  ])
  assert.deepEqual(await host.call("status", { backendID: "codex-native" }), {
    authentication: { state: "not-required" },
  })
  const created = Schema.decodeUnknownSync(Created)(await host.call("create", { backendID: "codex-native" }))
  const input = { ref: created.thread.ref, inputID: "product-input", text: "product-native-input" }
  const receipt = Schema.decodeUnknownSync(Admission)(await host.call("send", input))
  assert.equal(receipt.status, "accepted")
  await entered.promise
  await observer.resume(created.thread.ref.threadID)
  await host.stop()
  host = undefined
  assert.equal((await observer.read(created.thread.ref.threadID)).thread.status.type, "active")
  assert.equal(observer.runtimeInfo().pid, nativePID)
  checks.push(
    "the actual product CLI routes input to the original native PID and a product process exit does not stop its running work",
  )
  host = await boot()
  const restoredDeadline = Date.now() + 20_000
  while (((await host.call("list")) as unknown[]).length === 0 && Date.now() < restoredDeadline) await Bun.sleep(20)
  assert.deepEqual(await host.call("send", input), receipt)
  assert.equal(requests.length, 1)
  assert.equal((await command(product, "disable"))?.enabled, false)
  assert.equal(((await host.call("list")) as unknown[]).length, 1)
  release.resolve()
  const timer = setTimeout(() => completed.reject(new Error("Product native completion deadline")), 30_000)
  try {
    await completed.promise
  } finally {
    clearTimeout(timer)
  }
  assert(JSON.stringify(await host.call("history", { ref: created.thread.ref, limit: 10 })).includes("product-reply"))
  assert.deepEqual((await host.request("/api/session")).data, [])
  checks.push(
    "product restart preserves its SQLite admission receipt and native result without another model request or OpenCode Session",
  )
  await host.stop()
  host = await boot()
  assert.deepEqual(await host.call("list"), [])
  assert.equal(observer.runtimeInfo().pid, nativePID)
  assert(JSON.stringify(await observer.turns(created.thread.ref.threadID)).includes("product-reply"))
  checks.push(
    "disabled next boot detaches the product entry while the existing native service and history remain owned by Codex",
  )
  await host.stop()
  await setActivation(profile.home, true, executable)
  await writeFile(
    path.join(profile.home, "host-activation.json"),
    '{"version":1,"enabled":true,"plugin":"never-load-this"}',
  )
  host = await boot()
  assert.deepEqual(await host.call("list"), [])
  assert.deepEqual((await host.request("/api/session")).data, [])
  await command(product, "status", false)
  checks.push("malformed optional configuration cannot load arbitrary code or block the product core")
  assert.equal(requests.length, 1)
  console.log(
    JSON.stringify({
      status: "passed",
      checks,
      model_requests: requests.length,
      production_credentials_used: false,
      product_entry: "packages/im-assistant/src/cli.ts",
    }),
  )
} finally {
  release.resolve()
  await host?.stop()
  await observer.close()
  await stopSharedService(options)
  upstream.stop(true)
}
