// Public application Scope, original SQLite/KV and local OneBot only. No real account or external message.
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect, Exit, Scope } from "effect"
import { OpenCode } from "@opencode/client"
import type { ApplicationModule } from "@opencode/plugin/promise/application"
import { ServerFetch } from "../src/fetch"
import {
  configuredModule,
  createControlReplies,
  type ChannelIssue,
  type Result,
  type Source,
} from "../../../../modules/qq-portal/src"
import { originKey } from "../../../../modules/qq-portal/src/routing"
import { fakeOneBot, until, type Call } from "../../../../modules/qq-portal/test/fixture/onebot"

const root = process.env.IM_QQ_NOTIFICATION_OWNER_ROOT
if (!root) throw new Error("Use the isolated QQ acceptance runner")
const home = await mkdtemp(path.join(root, "notification-owner-")),
  directory = path.join(home, "location")
await mkdir(directory)
await mkdir(path.join(home, "config"))
const checks: string[] = [],
  issues: ChannelIssue[] = [],
  results: { source: Source; result: Result }[] = []
const fake = fakeOneBot({
  call(_socket, call) {
    if (call.action.startsWith("send_") && quote(call) === "860") {
      return true
    }
  },
})
const policy = { botID: "10001", allowedUsers: ["20001"], allowedGroups: [] }
const permissions = { allowedUsers: ["20001"] }
await writeFile(
  path.join(home, "channels.json"),
  JSON.stringify({
    version: 1,
    enabled: true,
    accounts: [{ url: fake.url, tokenEnv: "IM_QQ_TOKEN_OWNER", policy, controls: permissions }],
  }),
)
const source: Source = {
  scope: { botID: "10001", kind: "private", peerID: "20001" },
  actorID: "20001",
  messageID: "860",
}
const message = (id: number, text: string, reply?: string) => ({
  post_type: "message",
  self_id: 10001,
  message_type: "private",
  user_id: 20001,
  message_id: id,
  message: [...(reply ? [{ type: "reply", data: { id: reply } }] : []), { type: "text", data: { text } }],
})
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
function quote(call: Call) {
  if (!Array.isArray(call.params.message)) return undefined
  const part: unknown = call.params.message.find((part: unknown) => record(part) && part.type === "reply")
  return record(part) && record(part.data) ? part.data.id : undefined
}
const sends = () => fake.calls.filter((call) => call.action.startsWith("send_"))
let failPublication = false,
  closedWithReceipt = false
type Context = Parameters<ApplicationModule["open"]>[0]
let resources: Context | undefined
async function boot() {
  const module = await configuredModule(
    home,
    { IM_QQ_TOKEN_OWNER: fake.token },
    {
      onResult: (value) => {
        results.push(value)
      },
      onIssue: (value) => issues.push(value),
    },
  )
  assert(module)
  const owned: ApplicationModule = {
    id: module.id,
    open(context) {
      resources = context
      const storage = {
        ...context.storage,
        insert: async (key: string, value: Parameters<Context["storage"]["insert"]>[1]) => {
          if (failPublication && key.startsWith("control-view-published:"))
            throw new Error("Synthetic publication failure")
          return context.storage.insert(key, value)
        },
      }
      const resource = module.open({ ...context, storage })
      return {
        close: async () => {
          await resource.close()
          const receipt = await context.storage.get(
            "notification-receipt:control:" + originKey(source.scope, source.messageID),
          )
          if (record(receipt) && receipt.status === "uncertain") {
            await context.client.session.list()
            closedWithReceipt = true
          }
        },
      }
    },
  }
  const scope = Effect.runSync(Scope.make())
  try {
    const handler = await Effect.runPromise(
      ServerFetch.make(
        {
          database: { path: path.join(home, "app.sqlite") },
          models: { fetch: false },
          config: { directory: path.join(home, "config"), project: false, claude: false },
          runtime: { managedDirectory: directory },
          fs: { filewatcher: false },
        },
        { modules: [owned] },
      ).pipe(Effect.provideService(Scope.Scope, scope)),
    )
    const fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init)), {
      preconnect: () => undefined,
    })
    return {
      client: OpenCode.make({ baseUrl: "http://opencode.fixture", fetch }),
      close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    }
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    throw error
  }
}
let host: Awaited<ReturnType<typeof boot>> | undefined
try {
  host = await boot()
  await until(() => fake.calls.filter((call) => call.action === "get_status").length === 1)
  const session = await host.client.session.create({ title: "Notification ownership", location: { directory } })
  fake.event(message(860, "/list"))
  await until(() => sends().length === 1, 5000)
  assert.equal(
    await resources!.storage.get("notification-receipt:control:" + originKey(source.scope, source.messageID)),
    undefined,
  )
  assert.equal(sends().length, 1)
  await host.close()
  host = undefined
  assert(closedWithReceipt)
  checks.push(
    "application close settles the in-flight send as unknown and writes its receipt while original KV and public clients are still alive",
  )
  assert(resources)
  await assert.rejects(() =>
    resources!.storage.get("notification-receipt:control:" + originKey(source.scope, source.messageID)),
  )
  checks.push("after the owner finishes closing, escaped module clients cannot access the released application storage")

  host = await boot()
  await until(() => fake.calls.filter((call) => call.action === "get_status").length === 2)
  const before = results.length
  fake.event(message(860, "/list"))
  await until(() => results.length > before)
  assert.equal(sends().length, 1)
  const inspect = createControlReplies({
    storage: resources!.storage,
    policy,
    permissions,
    send: async () => {
      throw new Error("Inspection must not send")
    },
    publish: async () => {
      throw new Error("Inspection must not publish")
    },
  })
  assert.equal((await inspect.inspect(source)).status, "uncertain")
  checks.push("SQLite restart reads the unknown receipt without replaying its message, task or view publication")

  failPublication = true
  fake.event(message(861, "/list"))
  await until(() => issues.some((issue) => issue.kind === "notification-unlinked"))
  assert.equal(sends().length, 2)
  const sent = sends().find((call) => quote(call) === "861")
  const ack = fake.answers.find((reply) => reply.echo === sent?.echo)
  assert(ack?.status === "ok" && record(ack.data) && typeof ack.data.message_id === "number")
  const replyID = String(ack.data.message_id)
  const sentSource = { ...source, messageID: "861" }
  assert.equal((await inspect.inspect(sentSource)).status, "sent")
  checks.push(
    "a publication failure retains the actual wire acknowledgment instead of pretending the visual selectors were ready",
  )
  failPublication = false
  const replayed = results.length
  fake.event(message(861, "/list"))
  await until(() => results.length > replayed)
  assert.equal(sends().length, 2)
  fake.event(message(862, "/bind 1", replyID))
  await until(() => results.some((row) => row.source.messageID === "862"))
  const binding = results.find((row) => row.source.messageID === "862")!.result
  assert(
    binding.status === "control" &&
      binding.result.kind === "bound" &&
      binding.result.target.kind === "session" &&
      binding.result.target.sessionID === session.id,
  )
  checks.push(
    "duplicate delivery repairs only the acknowledged view metadata and its exact outgoing alias becomes usable without another send",
  )
  assert.equal(
    (await host.client.session.context({ sessionID: session.id })).filter((row) => row.type === "user").length,
    0,
  )
  assert.equal((await host.client.session.inbox.list({ sessionID: session.id })).length, 0)
  assert.equal(sends().length, 3)
  checks.push(
    "notification reconciliation and publication repair never create native task inputs or an execution queue",
  )
  console.log(
    JSON.stringify({
      status: "passed",
      checks,
      actual_qq_connection: false,
      external_messages_sent: 0,
      production_credentials_used: false,
      native_task_inputs: 0,
      loopback_send_attempts: sends().length,
      loopback_connections: fake.upgrades.length,
    }),
  )
} finally {
  await host?.close()
  fake.close()
}
