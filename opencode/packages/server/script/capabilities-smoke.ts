// Original native Scope/SQLite/Inbox/Runner only; optional capabilities never own AI execution.
import assert from "node:assert/strict"
import { mkdtemp, mkdir } from "node:fs/promises"
import path from "node:path"
import { Effect, Exit, Scope } from "effect"
import { OpenCode } from "@opencode/client"
import { Capability } from "@opencode/schema/capability"
import type { ApplicationModule } from "@opencode/plugin/promise/application"
import { ServerFetch } from "../src/fetch"

const root = process.env.IM_CAPABILITY_TEST_ROOT
if (!root) throw new Error("Use a private isolated capability acceptance root")
const home = await mkdtemp(path.join(root, "capabilities-"))
const directory = path.join(home, "location")
await mkdir(directory)
const checks: string[] = []
const requests: unknown[] = []
const release = Promise.withResolvers<void>()
const reached = Promise.withResolvers<void>()
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method !== "POST") return Response.json({ data: [] })
    requests.push(await request.json())
    const serial = requests.length
    if (serial === 1) {
      reached.resolve()
      await release.promise
    }
    return new Response(
      [
        {
          choices: [
            { index: 0, delta: { role: "assistant", content: "Native result " + serial }, finish_reason: null },
          ],
        },
        {
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
        },
      ]
        .map((value) => "data: " + JSON.stringify(value) + "\n\n")
        .join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
const config = {
  model: "baseline/baseline",
  update: "disable",
  share: "disabled",
  providers: {
    baseline: {
      name: "Loopback",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: `http://127.0.0.1:${upstream.port}/v1`, apiKey: "synthetic" },
      models: {
        baseline: {
          name: "Loopback",
          limit: { context: 32000, output: 1024 },
          capabilities: { tools: false, input: ["text"], output: ["text"] },
        },
      },
    },
  },
}
let moduleContext: Parameters<ApplicationModule["open"]>[0] | undefined
let closes = 0,
  samples = 0

async function boot() {
  const scope = Effect.runSync(Scope.make())
  try {
    const handler = await Effect.runPromise(
      ServerFetch.make(
        {
          database: { path: path.join(home, "native.sqlite") },
          models: { fetch: false },
          config: {
            directory: path.join(home, "config"),
            project: false,
            claude: false,
            content: JSON.stringify(config),
          },
          runtime: { managedDirectory: directory },
          fs: { filewatcher: false },
        },
        {
          modules: [
            {
              id: "unavailable",
              title: "Independent failing configuration",
              load: async () => {
                throw new Error("Synthetic module fault")
              },
            },
            {
              id: "observer",
              title: "Independent observer",
              open(context) {
                moduleContext = context
                context.capability.report({ phase: "ready" })
                return {
                  close: async () => {
                    closes++
                  },
                  metrics: async () => {
                    samples++
                    return [{ id: "requests", label: "Sample requests", value: samples, unit: "count" as const }]
                  },
                }
              },
            },
          ],
        },
      ).pipe(Effect.provideService(Scope.Scope, scope)),
    )
    const fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init)), {
      preconnect: () => undefined,
    })
    const client = OpenCode.make({
      baseUrl: "http://capability.fixture",
      headers: { "x-opencode-directory": encodeURIComponent(directory) },
      fetch,
    })
    return { client, api: client.rpc(Capability.Api), close: () => Effect.runPromise(Scope.close(scope, Exit.void)) }
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    throw error
  }
}
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 30000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Native capability observation deadline")
    await Bun.sleep(10)
  }
}

let host: Awaited<ReturnType<typeof boot>> | undefined
try {
  host = await boot()
  await until(async () =>
    (await host!.api.list({})).some((item) => item.id === "unavailable" && item.state === "failed"),
  )
  const session = await host.client.session.create({ title: "Native task ownership", location: { directory } })
  const first = await host.client.session.prompt({
    sessionID: session.id,
    text: "First native input",
    delivery: "queue",
  })
  await reached.promise
  const next = await host.client.session.prompt({
    sessionID: session.id,
    text: "Second native input",
    delivery: "queue",
  })
  assert.equal((await host.client.session.inbox.list({ sessionID: session.id }))[0]?.id, next.id)
  checks.push(
    "a failed optional configuration leaves the original native model call and durable successor Inbox usable",
  )

  const notice: Capability.NoticeInput = {
    id: "manual",
    title: "Manual action required",
    message: "An optional capability needs input",
    severity: "warning",
    requiresAction: true,
  }
  await moduleContext!.capability.notify(notice)
  await moduleContext!.capability.notify(notice)
  assert.deepEqual((await host.api.notifications({})).counts, { unread: 1, attention: 1 })
  await host.api.markRead({ moduleID: "observer", id: "manual" })
  assert.deepEqual((await host.api.notifications({})).counts, { unread: 0, attention: 1 })
  assert.equal(requests.length, 1)
  checks.push(
    "native metadata notification creation, deduplication and reading never admit another model task or resolve pending human action",
  )

  assert.equal(samples, 0)
  const measured = await Promise.all([host.api.metrics({ id: "observer" }), host.api.metrics({ id: "observer" })])
  assert(measured.every((item) => item.status === "ready"))
  assert.equal(samples, 1)
  assert.equal((await host.api.stop({ id: "observer" })).state, "stopped")
  assert.equal(closes, 1)
  assert.equal((await host.api.metrics({ id: "observer" })).status, "unavailable")
  assert.equal(samples, 1)
  assert.equal(requests.length, 1)
  assert.equal((await host.client.session.inbox.list({ sessionID: session.id }))[0]?.id, next.id)
  checks.push(
    "on-demand samples coalesce and stopping their application owner leaves the original running and queued AI inputs untouched",
  )

  release.resolve()
  await until(
    async () =>
      (await host!.client.session.input.position({ sessionID: session.id, inputID: next.id })).status === "closed",
  )
  const history = await host.client.session.context({ sessionID: session.id })
  assert.equal(requests.length, 2)
  assert.deepEqual(
    history.filter((row) => row.type === "user").map((row) => row.id),
    [first.id, next.id],
  )
  assert.deepEqual(
    history
      .filter((row) => row.type === "assistant")
      .flatMap((row) => row.content.filter((part) => part.type === "text").map((part) => part.text)),
    ["Native result 1", "Native result 2"],
  )
  checks.push(
    "the native runner completes the first input and immediately drains its original successor independently of the stopped capability",
  )

  await host.close()
  host = await boot()
  assert.deepEqual((await host.api.notifications({})).counts, { unread: 0, attention: 1 })
  await moduleContext!.capability.resolve("manual")
  assert.deepEqual((await host.api.notifications({})).counts, { unread: 0, attention: 0 })
  assert.equal(requests.length, 2)
  assert.equal(samples, 1)
  assert.equal(
    (await host.client.session.context({ sessionID: session.id })).filter((row) => row.type === "user").length,
    2,
  )
  checks.push(
    "native SQLite restart preserves unread and action facts separately without resuming completed work or starting a sampler",
  )

  console.log(
    JSON.stringify({
      status: "passed",
      checks,
      model_requests: requests.length,
      metric_samples: samples,
      actual_qq_connection: false,
      external_messages_sent: 0,
      production_credentials_used: false,
      native_state_owner: "original-opencode-application-session-inbox-sqlite",
      publication: "disabled",
    }),
  )
} finally {
  release.resolve()
  await host?.close()
  upstream.stop(true)
}
