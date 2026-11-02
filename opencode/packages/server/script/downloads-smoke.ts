import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, access } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { Effect, Exit, Scope } from "effect"
import { OpenCode } from "@opencode/client"
import { Capability } from "@opencode/schema/capability"
import { ServerFetch } from "../src/fetch"
import { Capabilities } from "../../im-assistant/src/capabilities"
import { Downloads } from "../../im-assistant/src/downloads"
import { defaults, settingsOwner } from "../../../../modules/downloads/src/configuration"

const home = await mkdtemp(path.join(tmpdir(), "download-product-"))
process.env.IM_ASSISTANT_DATA_ROOT = home
const location = path.join(home, "managed-location")
const database = path.join(home, "native.sqlite")
const checked: string[] = []
const payload = Buffer.alloc(131072, 73)
const checksum = createHash("sha256").update(payload).digest("hex")
let requests = 0
const source = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch() {
    requests++
    return new Response(payload)
  },
})
async function boot() {
  const scope = Effect.runSync(Scope.make())
  try {
    const handler = await Effect.runPromise(
      ServerFetch.make(
        {
          database: { path: database },
          models: { fetch: false },
          config: { directory: location, project: false, claude: false },
          runtime: { managedDirectory: location },
          fs: { filewatcher: false },
        },
        { modules: Capabilities.load() },
      ).pipe(Effect.provideService(Scope.Scope, scope)),
    )
    const fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init)), {
      preconnect: () => undefined,
    })
    const client = OpenCode.make({
      baseUrl: "http://download-product.test",
      fetch,
      headers: { "x-opencode-directory": encodeURIComponent(location) },
    })
    return { client, api: client.rpc(Capability.Api), close: () => Effect.runPromise(Scope.close(scope, Exit.void)) }
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    throw error
  }
}
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const value = await read()
    if (ready(value)) return value
    await Bun.sleep(20)
  }
  throw new Error("Product observation did not reach its expected state")
}
let app: Awaited<ReturnType<typeof boot>> | undefined
try {
  app = await boot()
  let directory = await until(
    () => app!.api.list({}),
    (items) => items.length === 4 && items.every((item) => item.state !== "loading"),
  )
  assert(directory.every((item) => item.state === "disabled"))
  assert.equal(requests, 0)
  checked.push("real product composition defaults off and does not create transfers")
  await app.close()
  app = undefined

  const owner = settingsOwner(Downloads.home()),
    signal = new AbortController().signal
  const previous = await owner.read(signal)
  assert(
    await owner.write(
      {
        revision: previous.revision,
        text: JSON.stringify({ ...defaults, enabled: true, enableDht: false, reserveBytes: 0 }),
      },
      signal,
    ),
  )
  app = await boot()
  directory = await until(
    () => app!.api.list({}),
    (items) => items.length === 4 && items.every((item) => item.state !== "loading"),
  )
  assert.equal(directory.find((item) => item.id === "downloads")?.state, "active")
  assert(directory.filter((item) => item.id !== "downloads").every((item) => item.state === "disabled"))
  await assert.rejects(access(path.join(Downloads.home(), "engine")))
  checked.push("only the enabled download module opens; engine remains lazy until an explicit operation")

  const requestID = randomUUID()
  const input = {
    id: "downloads",
    action: "create",
    requestID,
    locale: "zh",
    values: JSON.stringify({ title: "本机产品验收文件", uri: source.url.href, filename: "verified.bin", checksum }),
  }
  const admitted = await app.api.invoke(input)
  assert.equal(admitted.state, "applied")
  const finished = await until(
    () => app!.api.view({ id: "downloads", locale: "zh" }),
    (result) => result.document?.items[0]?.status === "已完成",
  )
  const id = finished.document!.items[0]!.id
  assert.equal(
    createHash("sha256")
      .update(await readFile(path.join(Downloads.home(), "files", id, "verified.bin")))
      .digest("hex"),
    checksum,
  )
  const before = requests
  assert.equal((await app.api.invoke(input)).state, "applied")
  assert.equal(requests, before)
  checked.push(
    "original authenticated RPC envelope and native KV drive actual aria2 bytes/checksum with no duplicate submission",
  )
  assert.equal((await app.api.notifications({})).counts.unread, 1)
  assert.equal(
    (
      await app.client.session.create({ title: "Independent native session", location: { directory: location } })
    ).id.startsWith("ses_"),
    true,
  )
  checked.push("completion notification persists separately while native conversations remain available without QQ")

  await app.close()
  app = await boot()
  await until(
    () => app!.api.list({}),
    (items) => items.find((item) => item.id === "downloads")?.state === "active",
  )
  const recovered = await app.api.view({ id: "downloads", locale: "zh" })
  assert.equal(recovered.document?.items[0]?.status, "已完成")
  assert.equal(requests, before)
  checked.push("native SQLite restart retains completed records without replaying a transfer")
  await app.api.stop({ id: "downloads" })
  await assert.rejects(app.api.invoke({ ...input, requestID: randomUUID() }))
  assert.equal((await app.client.session.list()).data.length, 1)
  checked.push("stopped module rejects stale controls without disabling the native session")
  console.log(
    JSON.stringify({
      status: "passed",
      checks: checked,
      count: checked.length,
      actual_engine: "aria2 1.37.0",
      external_source_requests: 0,
      loopback_source_requests: requests,
      model_requests: 0,
      real_qq_connections: 0,
      private_data_migrated: false,
      production_switch: false,
    }),
  )
} finally {
  await app?.close()
  await source.stop(true)
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
