// Actual product CLI and a local OneBot fixture only. No production accounts, login or external message.
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { OpenCode } from "@opencode/client"
import { Capability } from "@opencode/schema/capability"
import { fakeOneBot, until as observe, type Call } from "../../../../modules/qq-portal/test/fixture/onebot"
import { inputID } from "../../../../modules/qq-portal/src/routing"

const root = process.env.IM_QQ_PRODUCT_TEST_ROOT
if (!root) throw new Error("Use tools.qq_portal_smoke with an isolated root")
const product = await mkdtemp(path.join(root, "qq-product-"))
const entry = path.resolve(import.meta.dirname, "../../im-assistant/src/cli.ts")
const first = fakeOneBot({
    call(socket, call) {
      if (call.action.startsWith("send_") && quoteOf(call) === "810") {
        first.answer(socket, call, null, "async", 1)
        return true
      }
    },
  }),
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
async function command(action: string, success = true, botID?: string) {
  const child = Bun.spawn(
    [process.execPath, "run", entry, "portal", "qq", action, ...(botID !== undefined ? [botID] : [])],
    {
      env: env(),
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    },
  )
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
      botID?: string
      moduleEnabled?: boolean
      accountEnabled?: boolean
      accountCount: number
      enabledAccountCount: number
      connectionVerified: boolean
      controlRepliesSupported: boolean
      automaticTaskReplies: boolean
      taskReplyTargets: string[]
      appliesTo: string
    }
}
async function boot(authenticatedSecond = false) {
  const child = Bun.spawn([process.execPath, "run", entry, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    env: { ...env(), ...(authenticatedSecond ? { IM_QQ_TOKEN_SECOND: second.token } : {}) },
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
const message = (id: number, text: string, quote?: string) => ({
  post_type: "message",
  self_id: 10001,
  message_type: "private",
  user_id: 20001,
  message_id: id,
  message: [...(quote ? [{ type: "reply", data: { id: quote } }] : []), { type: "text", data: { text } }],
})
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
function quoteOf(call: Call) {
  if (!Array.isArray(call.params.message)) return undefined
  const reply: unknown = call.params.message.find((part: unknown) => record(part) && part.type === "reply")
  return record(reply) && record(reply.data) && typeof reply.data.id === "string" ? reply.data.id : undefined
}
function sendsFor(id: number) {
  return first.calls.filter((call) => call.action.startsWith("send_") && quoteOf(call) === String(id))
}
function sentText(id: number) {
  const parts = sendsFor(id)[0]?.params.message
  assert(Array.isArray(parts))
  return parts
    .map((part: unknown) =>
      record(part) && part.type === "text" && record(part.data) && typeof part.data.text === "string"
        ? part.data.text
        : "",
    )
    .join("")
}
function sentID(id: number) {
  const call = sendsFor(id)[0]
  assert(call)
  const answer = first.answers.find((reply) => reply.echo === call.echo)
  assert(answer?.status === "ok" && record(answer.data) && typeof answer.data.message_id === "number")
  return String(answer.data.message_id)
}

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
        policy: { botID: "10001", allowedUsers: ["20001"], allowedGroups: ["30001"] },
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
  await until(async () =>
    (await host!.client.rpc(Capability.Api).list({})).some(
      (item) => item.id === "qq-portal" && item.state === "disabled",
    ),
  )
  assert.equal(first.upgrades.length + second.upgrades.length, 0)
  checks.push(
    "the actual product entry starts native sessions with configured but disabled QQ and opens no optional socket",
  )
  const enabled = await command("enable")
  assert(
    enabled?.enabled &&
      enabled.appliesTo === "next-service-start" &&
      !enabled.connectionVerified &&
      enabled.controlRepliesSupported &&
      enabled.automaticTaskReplies &&
      enabled.taskReplyTargets.includes("session") &&
      enabled.taskReplyTargets.includes("backend"),
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
  await until(async () =>
    (await host!.client.rpc(Capability.Api).list({})).some(
      (item) => item.id === "qq-portal" && item.health?.phase === "degraded",
    ),
  )
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
  await observe(() => sendsFor(800).length === 1)
  assert(sentText(800).includes(session.id))
  assert.equal(quoteOf(sendsFor(800)[0]!), "800")
  checks.push(
    "a real product control receipt quotes its original command and uses the actual acknowledged OneBot message ID",
  )
  const extra = await host.client.session.prompt({
    sessionID: session.id,
    text: "Withdraw only this extra desktop item",
    delivery: "queue",
  })
  first.event(message(802, "/queue"))
  first.event(message(802, "/queue"))
  await observe(() => sendsFor(802).length === 1)
  assert(sentText(802).includes("2. Withdraw only this extra desktop item"))
  const queueReply = sentID(802)
  first.event(message(803, "/list"))
  await observe(() => sendsFor(803).length === 1)
  const line = sentText(803)
    .split("\n")
    .find((row) => row.includes(session.id))
  const index = line?.match(/^(\d+)\./)?.[1]
  assert(index)
  const catalogReply = sentID(803)
  first.event(message(804, "/bind " + index, catalogReply))
  await observe(() => sendsFor(804).length === 1)
  assert(sentText(804).includes(session.id))
  checks.push(
    "the product publishes the acknowledged catalog reply and a quoted displayed ordinal binds the exact native session",
  )
  first.event(message(805, "/unqueue 2", queueReply))
  await observe(() => sendsFor(805).length === 1)
  const remaining = await host.client.session.inbox.list({ sessionID: session.id })
  assert(remaining.some((row) => row.id === pending.id) && !remaining.some((row) => row.id === extra.id))
  assert(sentText(805).includes("已发出撤回请求"))
  checks.push("an acknowledged queue reply enables a stable ordinal withdrawal without cancelling the original QQ task")
  first.event(message(810, "/queue"))
  first.event(message(810, "/queue"))
  await observe(() => sendsFor(810).length === 1)
  first.event(message(811, "/unqueue 1", "810"))
  await observe(() => sendsFor(811).length === 1)
  assert(sentText(811).includes("已完整发布"))
  assert((await host.client.session.inbox.list({ sessionID: session.id })).some((row) => row.id === pending.id))
  assert.equal(sendsFor(810).length, 1)
  checks.push("an async/unknown send is not retried and cannot publish numeric selectors or cancel a native task")
  const group = {
    ...message(830, "/status"),
    message_type: "group",
    group_id: 30001,
    message: [
      { type: "at", data: { qq: "10001" } },
      { type: "text", data: { text: "/status" } },
    ],
  }
  first.event(group)
  first.event({ ...group, message_id: 831, message: [{ type: "text", data: { text: "/status" } }] })
  first.event({ ...group, message_id: 832, user_id: 29999 })
  first.event({ ...group, message_id: 833, group_id: 30002 })
  await observe(() => sendsFor(830).length === 1)
  assert.equal(sendsFor(830)[0]!.action, "send_group_msg")
  assert.equal(sendsFor(830)[0]!.params.group_id, 30001)
  assert(sentText(830).includes("尚未绑定"))
  checks.push(
    "group control output keeps its own binding and recipient and still requires the allowed group, member and bot mention",
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
  await observe(() => sendsFor(801).length === 1)
  assert.equal(sentText(801), "Product reply 2")
  assert.equal(first.calls.filter((row) => row.action.startsWith("send_")).length, 9)
  const output = await host.client.experimental.session.input.output({ sessionID: session.id, inputID: pending.id })
  assert.equal(output.rootID, pending.id)
  assert.equal(output.status, "closed")
  assert.equal(output.last?.text, "Product reply 2")
  for (const id of [831, 832, 833]) assert.equal(sendsFor(id).length, 0)
  checks.push(
    "disable does not interrupt native execution and the original QQ input receives its proven public reply exactly once while desktop output is not forwarded",
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
  await command("enable")
  host = await boot()
  await observe(
    () => first.upgrades.length === 2 && first.calls.filter((call) => call.action === "get_status").length === 2,
  )
  for (const input of [
    message(800, "/bind " + session.id),
    message(802, "/queue"),
    message(803, "/list"),
    message(810, "/queue"),
  ])
    first.event(input)
  first.event(message(820, "/bind " + index, catalogReply))
  await observe(() => sendsFor(820).length === 1)
  assert(sentText(820).includes(session.id))
  for (const id of [800, 802, 803, 810]) assert.equal(sendsFor(id).length, 1)
  assert.equal(requests.length, 2)
  checks.push(
    "SQLite restart reconciles successful and unknown notification receipts without another wire send or model request",
  )
  assert.equal(first.calls.filter((call) => call.action.startsWith("send_")).length, 10)
  first.event(task)
  await observe(() => first.calls.filter((call) => call.action === "get_status").length === 2)
  assert.equal(sendsFor(801).length, 1)
  assert.equal(requests.length, 2)
  checks.push(
    "native Session reply aliases and immutable send receipts survive restart and duplicate ingress without another model run or task result send",
  )
  assert.equal(sendsFor(803).length, 1)
  checks.push(
    "the original acknowledged catalog alias remains selectable after a real product restart without publishing a replacement reply",
  )
  await host.stop()

  const both = {
    ...config,
    enabled: true,
    accounts: config.accounts.map((account) => ({ ...account, controls: { allowedUsers: ["20001"] } })),
  }
  await writeFile(settings, JSON.stringify(both))
  const firstOff = await command("disable", true, "10001")
  assert(
    firstOff &&
      !firstOff.enabled &&
      firstOff.moduleEnabled &&
      !firstOff.accountEnabled &&
      firstOff.enabledAccountCount === 1,
  )
  assert.equal((await command("status", true, "10002"))?.enabled, true)
  const unchanged = await readFile(settings, "utf8")
  await command("disable", false, "99999")
  await command("disable", false, "")
  assert.equal(await readFile(settings, "utf8"), unchanged)
  host = await boot(true)
  await observe(() => second.calls.filter((call) => call.action === "get_status").length === 1)
  assert.equal(first.upgrades.length, 2)
  const other = await host.client.session.create({
    title: "Second task account native session",
    location: { directory: path.join(product, "session-location") },
    model: { providerID: "baseline", id: "baseline" },
  })
  const secondSends = (id: number) =>
    second.calls.filter((call) => call.action.startsWith("send_") && quoteOf(call) === String(id))
  second.event({ ...message(800, "/bind " + other.id), self_id: 10002 })
  await observe(() => secondSends(800).length === 1)
  const otherTask = { ...message(801, "Second bot owns this same peer and message ID"), self_id: 10002 }
  second.event(otherTask)
  second.event(otherTask)
  await observe(() => secondSends(801).length === 1, 30000)
  assert.equal(requests.length, 3)
  assert.equal(sendsFor(801).length, 1)
  assert.deepEqual(
    (await host.client.session.context({ sessionID: other.id }))
      .filter((row) => row.type === "user")
      .map((row) => row.text),
    ["Second bot owns this same peer and message ID"],
  )
  checks.push(
    "per-account disable leaves the sibling online and identical peer/message IDs retain separate native bindings, deduplication and replies",
  )

  await command("enable", true, "10001")
  await host.stop()
  host = await boot(true)
  await observe(
    () =>
      first.calls.filter((call) => call.action === "get_status").length === 3 &&
      second.calls.filter((call) => call.action === "get_status").length === 2,
  )
  first.event(message(850, "First bot after independent restart"))
  second.event({ ...message(850, "Second bot after independent restart"), self_id: 10002 })
  await observe(() => sendsFor(850).length === 1 && secondSends(850).length === 1, 30000)
  assert.equal(requests.length, 5)
  const firstTexts = (await host.client.session.context({ sessionID: session.id }))
    .filter((row) => row.type === "user")
    .map((row) => row.text)
  const secondTexts = (await host.client.session.context({ sessionID: other.id }))
    .filter((row) => row.type === "user")
    .map((row) => row.text)
  assert.deepEqual(firstTexts, [
    "Desktop holds the native runner",
    "One QQ input through the real product",
    "First bot after independent restart",
  ])
  assert.deepEqual(secondTexts, [
    "Second bot owns this same peer and message ID",
    "Second bot after independent restart",
  ])
  const firstAlias = first.answers.find((reply) => reply.echo === sendsFor(850)[0]!.echo)
  const secondAlias = second.answers.find((reply) => reply.echo === secondSends(850)[0]!.echo)
  assert(firstAlias?.status === "ok" && secondAlias?.status === "ok")
  const parent = (botID: string) => inputID({ scope: { botID, kind: "private", peerID: "20001" }, messageID: "850" })
  await until(
    async () =>
      (await host!.client.session.input.position({ sessionID: session.id, inputID: parent("10001") })).status ===
        "closed" &&
      (await host!.client.session.input.position({ sessionID: other.id, inputID: parent("10002") })).status ===
        "closed",
  )
  const firstFollowup = message(
    851,
    "First bot quoted follow-up",
    String((firstAlias.data as { message_id: number }).message_id),
  )
  const secondFollowup = {
    ...message(851, "Second bot quoted follow-up", String((secondAlias.data as { message_id: number }).message_id)),
    self_id: 10002,
  }
  for (const event of [firstFollowup, firstFollowup]) first.event(event)
  for (const event of [secondFollowup, secondFollowup]) second.event(event)
  await observe(() => sendsFor(851).length === 1 && secondSends(851).length === 1, 30000)
  assert.equal(requests.length, 7)
  for (const [botID, sessionID, text] of [
    ["10001", session.id, "First bot quoted follow-up"],
    ["10002", other.id, "Second bot quoted follow-up"],
  ] as const) {
    const history = await host.client.session.context({ sessionID })
    const followup = history.find((row) => row.type === "user" && row.text === text)
    assert(followup?.type === "user")
    assert.deepEqual(followup.metadata?.inputRelation, {
      kind: "followup",
      inputID: parent(botID),
      rootID: parent(botID),
    })
    assert.equal(history.filter((row) => row.type === "user" && row.text === text).length, 1)
  }
  checks.push(
    "two live accounts preserve separate SQLite bindings and acknowledged aliases after restart without cross-account history or result attribution",
  )

  first.event({
    ...group,
    message_id: 861,
    message: [
      { type: "at", data: { qq: "10003" } },
      { type: "text", data: { text: "Only the chat bot was mentioned" } },
    ],
  })
  first.event({ ...message(862, "Bot messages are not user tasks"), user_id: 10001 })
  first.event({ ...group, message_id: 863, user_id: 29999 })
  first.event(message(864, "/status"))
  await observe(() => sendsFor(864).length === 1)
  first.event({ ...message(860, "Other bot identity must not create a task"), self_id: 10003 })
  await observe(() => first.sockets.size === 0)
  second.event({ ...message(865, "/status"), self_id: 10002 })
  await observe(() => secondSends(865).length === 1)
  assert.equal(
    (await host.client.rpc(Capability.Api).list({})).find((item) => item.id === "qq-portal")?.health?.phase,
    "degraded",
  )
  for (const id of [860, 861, 862, 863]) assert.equal(sendsFor(id).length, 0)
  assert.equal(requests.length, 7)
  assert.equal(
    (await host.client.session.context({ sessionID: session.id })).filter((row) => row.type === "user").length,
    4,
  )
  assert.equal((await host.client.session.inbox.list({ sessionID: session.id })).length, 0)
  checks.push(
    "a chat-bot identity, mention of another bot, bot self-output and unauthorized group member cannot enter the task forwarding chain",
  )

  await command("disable", true, "10001")
  await command("disable", true, "10002")
  assert.equal((await command("status"))?.enabledAccountCount, 0)
  await host.stop()
  const connections = first.upgrades.length + second.upgrades.length
  host = await boot(true)
  assert.equal((await host.client.session.get({ sessionID: other.id })).id, other.id)
  assert.equal(first.upgrades.length + second.upgrades.length, connections)
  assert.equal(requests.length, 7)
  await command("disable")
  await command("enable", true, "10002")
  const masked = await command("status", true, "10002")
  assert(
    masked && masked.accountEnabled && !masked.moduleEnabled && !masked.enabled && masked.enabledAccountCount === 0,
  )
  checks.push(
    "all-disabled accounts leave the native application usable and the global off switch overrides individual desired state without deleting settings",
  )

  await host.stop()
  await writeFile(settings, JSON.stringify({ ...config, enabled: true, token: "never-accept-raw-secrets" }))
  await command("status", false)
  host = await boot()
  assert.equal((await host.client.session.get({ sessionID: session.id })).id, session.id)
  await until(async () =>
    (await host!.client.rpc(Capability.Api).list({})).some(
      (item) => item.id === "qq-portal" && item.state === "failed",
    ),
  )
  assert.equal(first.upgrades.length + second.upgrades.length, connections)
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
      independent_account_checks: 4,
      capability_status: "native-application-owner",
      isolated_quote_followups: 2,
      second_account_task_replies: secondSends(801).length + secondSends(850).length + secondSends(851).length,
      isolated_bot_identities: ["10001", "10002"],
      automatic_task_replies: "native-input-attribution",
      loopback_task_send_attempts: [first, second].reduce(
        (count, account) =>
          count +
          account.calls.filter(
            (call) => call.action.startsWith("send_") && ["801", "850", "851"].includes(quoteOf(call) ?? ""),
          ).length,
        0,
      ),
      loopback_control_send_attempts: [first, second].reduce(
        (count, account) =>
          count +
          account.calls.filter(
            (call) => call.action.startsWith("send_") && !["801", "850", "851"].includes(quoteOf(call) ?? ""),
          ).length,
        0,
      ),
      loopback_confirmed_control_replies: [first, second].reduce(
        (count, account) =>
          count +
          account.answers.filter(
            (answer) =>
              answer.status === "ok" &&
              record(answer.data) &&
              "message_id" in answer.data &&
              account.calls.some(
                (call) =>
                  call.echo === answer.echo &&
                  call.action.startsWith("send_") &&
                  !["801", "850", "851"].includes(quoteOf(call) ?? ""),
              ),
          ).length,
        0,
      ),
    }),
  )
} catch (error) {
  console.error(
    JSON.stringify({
      completed_checks: checks.length,
      last_check: checks.at(-1),
      model_requests: requests.length,
      accounts: [first, second].map((account) => ({
        connections: account.upgrades.length,
        calls: account.calls.map((call) => ({ action: call.action, quote: quoteOf(call) })),
      })),
    }),
  )
  throw error
} finally {
  release.resolve()
  await host?.stop()
  first.close()
  second.close()
  upstream.stop(true)
}
