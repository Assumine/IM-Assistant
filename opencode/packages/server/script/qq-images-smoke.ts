// Real application SQLite/Session and pinned Codex service. Synthetic images and loopback transports only.
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect, Exit, Scope } from "effect"
import { OpenCode } from "@opencode/client"
import { ConversationBackend } from "@opencode/schema/conversation-backend"
import { ServerFetch } from "../src/fetch"
import {
  CodexSessionAdapter,
  createSharedProfile,
  nativeModule,
  stopSharedService,
} from "../../../../modules/codex-native/src"
import { configuredModule, type Source, type Result } from "../../../../modules/qq-portal/src"
import { inputID } from "../../../../modules/qq-portal/src/routing"
import { fakeOneBot, until, type Call } from "../../../../modules/qq-portal/test/fixture/onebot"
import { png, imageName, imagePart } from "../../../../modules/qq-portal/test/fixture/images"

const root = process.env.IM_QQ_IMAGES_ROOT,
  executable = process.env.IM_CODEX_EXECUTABLE
if (!root || !executable) throw new Error("Use an isolated QQ image acceptance profile")
const home = await mkdtemp(path.join(root, "images-"))
await mkdir(path.join(home, "config"))
const checks: string[] = [],
  requests: { native: boolean; body: unknown }[] = [],
  results: { source: Source; result: Result }[] = []
const ordinary = Promise.withResolvers<void>(),
  nativeGate = Promise.withResolvers<void>(),
  nativeImageGate = Promise.withResolvers<void>(),
  nativeFinalGate = Promise.withResolvers<void>(),
  imageGate = Promise.withResolvers<void>()
let imageReads = 0,
  holdImage = false,
  missingImage = false
const fake = fakeOneBot({
  call(socket, call) {
    if (call.action !== "get_image") return
    imageReads++
    assert.deepEqual(call.params, { file: imageName })
    const respond = () =>
      fake.answer(
        socket,
        call,
        missingImage
          ? { file: "C:/never-read", url: "https://never-fetch.invalid/private" }
          : { base64: png, file: "C:/never-read", url: "https://never-fetch.invalid/private", file_size: "68" },
      )
    if (holdImage) void imageGate.promise.then(respond)
    else respond()
    return true
  },
})
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method !== "POST") return Response.json({ data: [] })
    const native = new URL(request.url).pathname.endsWith("/responses")
    requests.push({ native, body: await request.json() })
    const serial = requests.filter((item) => item.native === native).length
    if (serial === 1) await (native ? nativeGate : ordinary).promise
    if (native && serial === 2) await nativeImageGate.promise
    if (native && serial === 3) await nativeFinalGate.promise
    if (!native)
      return new Response(
        [
          {
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "Ordinary image result " + serial },
                finish_reason: null,
              },
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
    const item = {
      id: "msg_image_" + serial,
      type: "message",
      role: "assistant",
      phase: "final_answer",
      status: "completed",
      content: [{ type: "output_text", text: "Native image result " + serial, annotations: [] }],
    }
    return new Response(
      [
        { type: "response.created", response: { id: "resp_image_" + serial, status: "in_progress" } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress" } },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            id: "resp_image_" + serial,
            status: "completed",
            output: [item],
            usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
          },
        },
      ]
        .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        .join(""),
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
const profile = await createSharedProfile(path.join(home, "codex"), {
  id: "fixture",
  model: "local-fixture",
  baseURL: `http://127.0.0.1:${upstream.port}/v1`,
  keyName: "IM_FIXTURE_KEY",
})
const launch = { executable, profile, apiKey: "fixture-only" },
  native = await CodexSessionAdapter.open(launch)
const policy = { botID: "10001", allowedUsers: ["20001"], allowedGroups: [] }
await writeFile(
  path.join(home, "channels.json"),
  JSON.stringify({
    version: 1,
    enabled: true,
    accounts: [
      {
        policy,
        url: fake.url,
        tokenEnv: "IM_QQ_TOKEN_IMAGES",
        controls: { allowedUsers: ["20001"], backendIDs: ["codex-native"] },
        images: { provider: "napcat" },
      },
    ],
  }),
)
const config = {
  model: "baseline/baseline",
  update: "disable",
  share: "disabled",
  providers: {
    baseline: {
      name: "Loopback image fixture",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: `http://127.0.0.1:${upstream.port}/v1`, apiKey: "synthetic" },
      models: {
        baseline: {
          name: "Loopback",
          limit: { context: 32000, output: 1024 },
          capabilities: { tools: false, input: ["text", "image"], output: ["text"] },
        },
      },
    },
  },
}
const source = (id: number): Source => ({
  scope: { botID: "10001", kind: "private", peerID: "20001" },
  actorID: "20001",
  messageID: String(id),
})
const nativeID = (id: number) => inputID(source(id))
const message = (id: number, text: string, image = false, quote?: number) => ({
  post_type: "message",
  self_id: "10001",
  message_type: "private",
  user_id: "20001",
  message_id: id,
  message: [
    ...(quote ? [{ type: "reply", data: { id: String(quote) } }] : []),
    { type: "text", data: { text } },
    ...(image ? [imagePart] : []),
  ],
})
const recall = (id: number) => ({ ...message(id, ""), post_type: "notice", notice_type: "friend_recall" })
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
function quote(call: Call) {
  assert(Array.isArray(call.params.message))
  const part: unknown = call.params.message.find((part: unknown) => record(part) && part.type === "reply")
  return record(part) && record(part.data) ? part.data.id : undefined
}
const sends = (id: number) => fake.calls.filter((call) => call.action.startsWith("send_") && quote(call) === String(id))
const result = async (id: number, status: string) =>
  until(() => results.some((value) => value.source.messageID === String(id) && value.result.status === status), 30000)
async function boot() {
  const module = await configuredModule(
    home,
    { IM_QQ_TOKEN_IMAGES: fake.token },
    {
      onResult: (value) => {
        results.push(value)
      },
    },
  )
  assert(module)
  const scope = Effect.runSync(Scope.make())
  try {
    const handler = await Effect.runPromise(
      ServerFetch.make(
        {
          database: { path: path.join(home, "app.sqlite") },
          models: { fetch: false },
          config: {
            directory: path.join(home, "config"),
            project: false,
            claude: false,
            content: JSON.stringify(config),
          },
          runtime: { managedDirectory: profile.workspace },
          fs: { filewatcher: false },
        },
        { modules: [module], backends: [nativeModule(launch)] },
      ).pipe(Effect.provideService(Scope.Scope, scope)),
    )
    const fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init)), {
      preconnect: () => undefined,
    })
    const client = OpenCode.make({
      baseUrl: "http://opencode.images",
      fetch,
      headers: { "x-opencode-directory": encodeURIComponent(profile.workspace) },
    })
    const backend = client.rpc(ConversationBackend.Api)
    await until(async () => (await backend.list({})).some((item) => item.id === "codex-native" && item.images), 30000)
    return { client, backend, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) }
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    throw error
  }
}
let host: Awaited<ReturnType<typeof boot>> | undefined
try {
  host = await boot()
  await until(() => fake.calls.some((call) => call.action === "get_status"), 30000)
  const session = await host.client.session.create({
    title: "Controlled image",
    location: { directory: profile.workspace },
  })
  fake.event(message(101, "/bind " + session.id))
  await result(101, "control")
  await host.client.session.prompt({
    sessionID: session.id,
    id: "msg_image_desktop",
    text: "Hold ordinary desktop task",
    delivery: "queue",
  })
  await until(() => requests.some((request) => !request.native), 30000)
  fake.event(message(102, "Inspect the synthetic picture", true))
  await result(102, "accepted")
  const pending = await host.client.session.inbox.list({ sessionID: session.id })
  assert.deepEqual(
    pending.map((item) => item.id),
    [nativeID(102)],
  )
  const stored = pending[0]
  assert(stored?.type === "user" && stored.payload.files?.length === 1 && stored.payload.files[0]?.mime === "image/png")
  fake.event(message(102, "Inspect the synthetic picture", true))
  await until(() => results.filter((value) => value.source.messageID === "102").length === 2)
  assert.equal(imageReads, 1)
  checks.push("QQ text and image share one durable native Inbox item; a live duplicate only reconciles")
  fake.event(recall(103))
  await result(103, "unchanged")
  fake.event(message(103, "Never retrieve this image", true))
  await result(103, "recalled")
  holdImage = true
  fake.event(message(104, "Recall while downloading", true))
  await until(() => imageReads === 2)
  fake.event(recall(104))
  imageGate.resolve()
  await result(104, "withdrawn")
  holdImage = false
  assert.deepEqual(
    (await host.client.session.inbox.list({ sessionID: session.id })).map((item) => item.id),
    [nativeID(102)],
  )
  checks.push("recalls before retrieval and during transfer never produce a model-visible task")
  ordinary.resolve()
  await until(() => sends(102).length === 1, 30000)
  const ordinaryBody = JSON.stringify(requests.filter((request) => !request.native).at(-1)?.body)
  assert(ordinaryBody.includes("image_url") && ordinaryBody.includes("data:image/png;base64,"))
  assert(!ordinaryBody.includes("never-fetch") && !ordinaryBody.includes("never-read"))
  checks.push("the real original runner reads stored image bytes and sends them through the model image channel")
  missingImage = true
  fake.event(message(105, "Missing image bytes", true))
  await result(105, "blocked")
  fake.event(message(105, "Missing image bytes", true))
  await until(() => results.filter((value) => value.source.messageID === "105").length === 2)
  assert.equal(imageReads, 3)
  assert.equal(sends(105).length, 1)
  missingImage = false
  fake.event(message(106, "No partial quoted image", true, 102))
  await result(106, "blocked")
  assert.equal(imageReads, 3)
  assert.equal(sends(106).length, 1)
  checks.push(
    "unavailable bytes and text-only quoted Session endpoints refuse once, without partial text or repeated downloads",
  )
  const ref = (await host.backend.create({ backendID: "codex-native" })).thread.ref
  fake.event(message(107, "/bind backend " + ref.backendID + " " + ref.threadID))
  await result(107, "control")
  await host.backend.send({ ref, inputID: "image_native_desktop", text: "Hold native desktop task" })
  await until(() => requests.some((request) => request.native), 30000)
  fake.event(message(108, "", true))
  await result(108, "accepted")
  const queued = (await native.queue(ref.threadID)).data.find((item) => item.clientUserMessageId === nativeID(108))
  assert(queued && queued.input.some((part) => part.type === "image" && part.url === "data:image/png;base64," + png))
  await assert.rejects(
    host.backend.control({
      backendID: ref.backendID,
      control: { action: "update", threadID: ref.threadID, nativeID: queued.id, text: "Do not erase the image" },
    }),
  )
  assert.deepEqual((await native.queue(ref.threadID)).data.find((item) => item.id === queued.id)?.input, queued.input)
  await assert.rejects(
    host.backend.send({
      ref,
      inputID: nativeID(108),
      text: "",
      files: [{ uri: "data:image/png;base64," + Buffer.from("different image").toString("base64") }],
    }),
  )
  checks.push(
    "whole native backend queues image-only input, rejects conflicting reuse, and blocks text edits that erase images",
  )
  fake.event(message(108, "", true))
  await until(() => results.filter((value) => value.source.messageID === "108").length === 2)
  assert.equal(imageReads, 4)
  nativeGate.resolve()
  await until(() => requests.filter((request) => request.native).length === 2, 30000)
  fake.event(message(110, "Live image correction", true, 108))
  await result(110, "steered")
  nativeImageGate.resolve()
  await until(() => requests.filter((request) => request.native).length === 3, 30000)
  const inFlight = await host.backend.output({ ref, inputID: nativeID(108) })
  assert(
    inFlight.status === "unknown" || (inFlight.status === "open" && !inFlight.first?.settled),
    JSON.stringify(inFlight),
  )
  assert.equal(sends(108).length, 0)
  nativeFinalGate.resolve()
  await until(() => sends(108).length === 1, 30000)
  const nativeBody = JSON.stringify(requests.filter((request) => request.native).at(-1)?.body)
  assert(nativeBody.includes("input_image") && nativeBody.includes("data:image/png;base64," + png))
  checks.push(
    "a quoted image adjustment targets its observed active turn; unsettled interim text is withheld and the final result quotes the original task",
  )
  fake.event(message(109, "Continue examining the picture", true, 108))
  await result(109, "followup")
  await until(() => sends(109).length === 1, 30000)
  checks.push(
    "pinned Codex receives real inline image input and a quoted terminal follow-up uses its original native thread",
  )
  const sessions = await host.client.session.list({})
  assert.deepEqual(
    sessions.data.map((item) => item.id),
    [session.id],
  )
  assert.equal(requests.length, 6)
  assert.equal(imageReads, 6)
  const readCount = imageReads,
    requestCount = requests.length
  await host.close()
  host = undefined
  results.length = 0
  host = await boot()
  await until(
    () => fake.upgrades.length === 2 && fake.calls.filter((call) => call.action === "get_status").length === 2,
    30000,
  )
  fake.event(message(108, "", true))
  await result(108, "accepted")
  assert.equal(imageReads, readCount)
  assert.equal(requests.length, requestCount)
  assert.equal(sends(108).length, 1)
  const persisted = await host.client.session.message.get({ sessionID: session.id, messageID: nativeID(102) })
  assert(persisted.type === "user" && persisted.files?.[0]?.mime === "image/png")
  checks.push(
    "host restart preserves original image storage and native receipts without replay, shadow Sessions or duplicate output",
  )
  console.log(
    JSON.stringify({
      status: "passed",
      checks,
      model_requests: requests.length,
      image_reads: imageReads,
      loopback_connections: fake.upgrades.length,
      actual_qq_connection: false,
      external_messages_sent: 0,
      production_credentials_used: false,
    }),
  )
} catch (error) {
  console.error(
    JSON.stringify({
      completed_checks: checks,
      model_requests: requests.map((request) => ({ native: request.native })),
      image_reads: imageReads,
      results: results.map((value) => ({ messageID: value.source.messageID, result: value.result })),
      output_quotes: fake.calls.filter((call) => call.action.startsWith("send_")).map(quote),
    }),
  )
  throw error
} finally {
  ordinary.resolve()
  nativeGate.resolve()
  nativeImageGate.resolve()
  nativeFinalGate.resolve()
  imageGate.resolve()
  await host?.close()
  await native.close()
  await stopSharedService(launch)
  fake.close()
  upstream.stop(true)
}
