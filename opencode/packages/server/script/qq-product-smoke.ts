// Actual product CLI and a local OneBot fixture only. No production accounts, login or external message.
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { OpenCode } from "@opencode/client"
import { fakeOneBot, until as observe } from "../../../../modules/qq-portal/test/fixture/onebot"

const root = process.env.IM_QQ_PRODUCT_TEST_ROOT
if (!root) throw new Error("Use tools.qq_portal_smoke with an isolated root")
const product = await mkdtemp(path.join(root, "qq-product-"))
const entry = path.resolve(import.meta.dirname, "../../im-assistant/src/cli.ts")
const first = fakeOneBot(),
  second = fakeOneBot({ botID: "10002" })
const checks: string[] = [],
  requests: unknown[] = []
const release = Promise.withResolvers<void>()
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method !== "POST") return Response.json({ data: [] })
    requests.push(await request.json())
    const serial = requests.length
    if (serial === 1) {
      await release.promise
    }
    return new Response(
      [
        {
          choices: [
            { index: 0, delta: { role: "assistant", content: "Product reply " + serial }, finish_reason: null },
          ],
        },
        {
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      ]
        .map((chunk) => "data: " + JSON.stringify(chunk) + "\n\n")
        .join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})

const env = () => ({
  ...process.env,
  IM_ASSISTANT_DATA_ROOT: product,
  OPENCODE_DISABLE_MODELS_FETCH: "true",
  IM_QQ_TOKEN_FIRST: first.token,
  IM_QQ_TOKEN_SECOND: "wrong-fixture-token",
})
async function command(action: string, success = true) {
  const child = Bun.spawn([process.execPath, "run", entry, "portal", "qq", action], {
    env: env(),
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
  assert(!output.includes(first.token) && !error.includes(first.token))
  if (success)
    return JSON.parse(output) as {
      enabled: boolean
      accountCount: number
      connectionVerified: boolean
      automaticReplies: boolean
      appliesTo: string
    }
}
async function boot() {
  const child = Bun.spawn([process.execPath, "run", entry, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    env: env(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const ready = Promise.withResolvers<void>()
  let url: string | undefined, password: string | undefined
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
  const timer = setTimeout(() => ready.reject(new Error("Product boot deadline")), 30000)
  const exited = child.exited.then(() => ready.reject(new Error("Product exited before ready")))
  const stop = async () => {
    child.kill()
    const [, , error] = await Promise.all([child.exited, reading, errors, exited])
    assert(!error.includes(first.token) && !error.includes("wrong-fixture-token"))
  }
  try {
    await ready.promise
  } catch (error) {
    await stop()
    throw error
  } finally {
    clearTimeout(timer)
  }
  assert(url && password)
  const client = OpenCode.make({
    baseUrl: url,
    headers: {
      authorization: "Basic " + Buffer.from("opencode:" + password).toString("base64"),
      "x-opencode-directory": encodeURIComponent(path.join(product, "session-location")),
    },
  })
  return { client, stop }
}
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 30000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Product observation deadline")
    await Bun.sleep(20)
  }
}
const message = (id: number, text: string) => ({
  post_type: "message",
  self_id: 10001,
  message_type: "private",
  user_id: 20001,
  message_id: id,
  message: [{ type: "text", data: { text } }],
})

let host: Awaited<ReturnType<typeof boot>> | undefined
try {
  assert.equal((await command("status"))?.enabled, false)
  assert.equal((await command("init"))?.enabled, false)
  await command("init", false)
  await command("enable", false)
  checks.push(
    "product commands remain disabled until configured and initialization refuses to adopt an existing settings file",
  )
  const settings = path.join(product, "modules", "qq-portal", "channels.json")
  const config = {
    version: 1,
    enabled: false,
    accounts: [
      {
        url: first.url,
        tokenEnv: "IM_QQ_TOKEN_FIRST",
        policy: { botID: "10001", allowedUsers: ["20001"], allowedGroups: [] },
        controls: { allowedUsers: ["20001"] },
      },
      {
        url: second.url,
        tokenEnv: "IM_QQ_TOKEN_SECOND",
        policy: { botID: "10002", allowedUsers: ["20001"], allowedGroups: [] },
      },
    ],
  }
  await writeFile(settings, JSON.stringify(config))
  await writeFile(
    path.join(product, "native", "config", "opencode", "opencode.json"),
    JSON.stringify({
      update: "disable",
      share: "disabled",
      model: "baseline/baseline",
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
    }),
  )
  host = await boot()
  const session = await host.client.session.create({
    title: "Product native session",
    location: { directory: path.join(product, "session-location") },
    model: { providerID: "baseline", id: "baseline" },
  })
  assert.equal((await host.client.session.get({ sessionID: session.id })).id, session.id)
  assert.equal(first.upgrades.length + second.upgrades.length, 0)
  checks.push(
    "the actual product entry starts native sessions with configured but disabled QQ and opens no optional socket",
  )
  const enabled = await command("enable")
  assert(
    enabled?.enabled &&
      enabled.appliesTo === "next-service-start" &&
      !enabled.connectionVerified &&
      !enabled.automaticReplies,
  )
  assert.equal(first.upgrades.length + second.upgrades.length, 0)
  checks.push(
    "explicit enable changes only the next service start and its CLI status does not claim a live connection or reply delivery",
  )
  await host.stop()
  host = await boot()
  await observe(() => first.calls.length === 2 && second.upgrades.length === 1)
  assert.deepEqual(
    first.calls.map((row) => row.action),
    ["get_login_info", "get_status"],
  )
  assert.equal(second.calls.length, 0)
  assert.equal((await host.client.session.get({ sessionID: session.id })).id, session.id)
  checks.push(
    "actual product composition opens a verified account while another account's rejected token leaves the native core usable",
  )
  for (const title of ["Capability first", "Capability second"]) {
    const other = await host.client.session.create({
      title,
      location: { directory: path.join(product, "session-location") },
    })
    await host.client.permission.list({ sessionID: other.id })
  }
  assert.equal(first.upgrades.length, 1)
  assert.equal(second.upgrades.length, 1)
  checks.push("multiple native sessions and capability boots do not recreate application-owned QQ connections")
  await host.client.session.prompt({
    sessionID: session.id,
    text: "Desktop holds the native runner",
    delivery: "queue",
  })
  await until(async () => requests.length === 1)
  first.event(message(800, "/bind " + session.id))
  const task = message(801, "One QQ input through the real product")
  first.event(task)
  first.event(task)
  await until(
    async () =>
      (await host!.client.session.inbox.list({ sessionID: session.id })).filter((row) => row.type === "user").length ===
      1,
  )
  const pending = (await host.client.session.inbox.list({ sessionID: session.id }))[0]!
  assert(pending.type === "user" && pending.payload.text === "One QQ input through the real product")
  assert.equal(requests.length, 1)
  checks.push(
    "product QQ binds and repeated wire input use the same original native Inbox beside desktop work without a second execution queue",
  )
  assert.equal((await command("disable"))?.enabled, false)
  assert.equal(first.sockets.size, 1)
  release.resolve()
  await until(
    async () =>
      (await host!.client.session.input.position({ sessionID: session.id, inputID: pending.id })).status === "closed",
  )
  const history = await host.client.session.context({ sessionID: session.id })
  assert.equal(requests.length, 2)
  assert.deepEqual(
    history.filter((row) => row.type === "user").map((row) => row.text),
    ["Desktop holds the native runner", "One QQ input through the real product"],
  )
  assert.equal(first.calls.filter((row) => row.action.startsWith("send_")).length, 0)
  checks.push(
    "disable does not interrupt current native execution, and the original runner drains the sole QQ input once; no automatic output sender is claimed",
  )
  await host.stop()
  await observe(() => first.sockets.size === 0)
  host = await boot()
  assert.equal((await host.client.session.get({ sessionID: session.id })).id, session.id)
  assert.equal(
    (await host.client.session.context({ sessionID: session.id })).filter((row) => row.type === "user").length,
    2,
  )
  assert.equal(first.upgrades.length, 1)
  assert.equal(second.upgrades.length, 1)
  assert.equal(requests.length, 2)
  checks.push(
    "disabled next boot preserves native SQLite history without a QQ login, another connection or model replay",
  )
  await host.stop()
  await writeFile(settings, JSON.stringify({ ...config, enabled: true, token: "never-accept-raw-secrets" }))
  await command("status", false)
  host = await boot()
  assert.equal((await host.client.session.get({ sessionID: session.id })).id, session.id)
  assert.equal(first.upgrades.length + second.upgrades.length, 2)
  assert(!(await readFile(settings, "utf8")).includes(first.token))
  checks.push("malformed optional settings are rejected without opening sockets or blocking the actual product core")
  console.log(
    JSON.stringify({
      status: "passed",
      checks,
      model_requests: requests.length,
      actual_qq_connection: false,
      external_messages_sent: 0,
      production_credentials_used: false,
      product_entry: "packages/im-assistant/src/cli.ts",
      loopback_connection_attempts: first.upgrades.length + second.upgrades.length,
      automatic_replies: false,
    }),
  )
} finally {
  release.resolve()
  await host?.stop()
  first.close()
  second.close()
  upstream.stop(true)
}
