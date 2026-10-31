import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { CodexSessionAdapter, createProfile, createSharedProfile, stopSharedService, loadProfile, nativeBackend, NativeError, OutcomeUnknown, type Notification, type Profile } from "../src"
import { policy } from "../src/profile"
import { Transport } from "../src/transport"
import type { ConversationBackend } from "../../../opencode/packages/schema/src/conversation-backend"

const executable = process.env.IM_CODEX_EXECUTABLE
const root = process.env.IM_CODEX_TEST_ROOT
if (!executable || !root) throw new Error("Run through tools/codex_native_smoke.py with an isolated profile")
const cleanup: (() => Promise<unknown> | unknown)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
type Body = { input?: Record<string, unknown>[]; tools?: { name?: string; type: string }[]; [key: string]: unknown }
type Handler = (body: Body, serial: number, url: URL) => Promise<Record<string, unknown>> | Record<string, unknown>
function reply(serial: number, text = `native-reply-${serial}`) {
  return { id: `msg_${serial}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }
}
function fixture(handler: Handler = (_, serial) => reply(serial), stream?: { entered: () => void; release: Promise<void> }) {
  const requests: { body: Body; url: URL }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method === "GET") return Response.json({ data: [] })
      const body = await request.json() as Body
      requests.push({ body, url })
      const serial = requests.length
      const item = await handler(body, serial, url)
      if (url.pathname.endsWith("/compact")) return Response.json(item)
      const events = [
        { type: "response.created", response: { id: `resp_${serial}`, status: "in_progress" } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress" } },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: `resp_${serial}`, status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105, input_tokens_details: { cached_tokens: 0 } } } },
      ]
      if (serial === 1 && stream) {
        const encoder = new TextEncoder()
        const fullText = "native-reply-1"
        return new Response(new ReadableStream({
          async start(controller) {
            const push = (event: Record<string, unknown>) => controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`))
            push(events[0])
            push({ ...events[1], item: { ...item, status: "in_progress", content: [] } })
            push({ type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } })
            push({ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "native-" })
            stream.entered()
            await stream.release
            push({ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "reply-1" })
            push({ type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: fullText })
            push({ type: "response.content_part.done", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: fullText, annotations: [] } })
            push(events[2]); push(events[3]); controller.close()
          },
        }), { headers: { "content-type": "text/event-stream" } })
      }
      return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  cleanup.push(() => server.stop(true))
  return { requests, url: `http://127.0.0.1:${server.port}/v1` }
}
async function start(url: string) {
  const home = await mkdtemp(path.join(root!, "profile-"))
  const profile = await createProfile(home, { id: "fixture", model: "local-fixture", baseURL: url, keyName: "IM_FIXTURE_KEY" })
  const adapter = await open(profile)
  return { adapter, profile }
}
async function open(profile: Profile) {
  const adapter = await CodexSessionAdapter.open({ executable: executable!, profile, apiKey: "fixture-not-real" })
  cleanup.push(() => adapter.close())
  return adapter
}
function observe(adapter: CodexSessionAdapter) {
  const events: Notification[] = []
  const waiters = new Set<() => void>()
  adapter.subscribe((event) => { events.push(event); for (const wake of waiters) wake() })
  async function wait(predicate: (event: Notification) => boolean) {
    const found = () => events.find(predicate)
    if (found()) return found()!
    return new Promise<Notification>((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(check); reject(new Error("Native event deadline exceeded")) }, 25000)
      function check() {
        const value = found()
        if (!value) return
        clearTimeout(timer)
        waiters.delete(check)
        resolve(value)
      }
      waiters.add(check)
      check()
    })
  }
  return { events, wait }
}
function completed(event: Notification) { return event.method === "turn/completed" }
function text(body: Body) {
  return JSON.stringify(body.input)
}

describe("real Codex App Server (local synthetic model, no user credentials)", () => {
  test("human input stays pending across observers, validates scoped answers and waits for native resolution", async () => {
    const entered = deferred<void>()
    const release = deferred<void>()
    cleanup.push(() => release.resolve())
    const upstream = fixture(async (_, serial) => {
      if (serial === 1) { entered.resolve(); await release.promise }
      return serial <= 5 && serial % 2 === 1 ? {
        id: `fc_question_${serial}`, call_id: `call_question_${serial}`, type: "function_call", name: "request_user_input", status: "completed",
        arguments: JSON.stringify({ questions: [
          { id: "choice", header: "Pick", question: "Choose a direction", options: [{ label: "Alpha", description: "First" }, { label: "Beta", description: "Second" }] },
          { id: "detail", header: "Detail", question: "What should we keep?", options: [{ label: "Simple", description: "Keep it small" }, { label: "Full", description: "Include details" }] },
        ] }),
      } : reply(serial)
    })
    const options = await managed(upstream.url)
    const first = await open(options.profile)
    const second = await open(options.profile)
    const observer = observe(first)
    const other = observe(second)
    const backend = nativeBackend(first)
    const execution = backend.execution!
    const { thread } = await first.create()
    const wrong = await first.create()
    const ref = { backendID: backend.descriptor.id, threadID: thread.id }
    const pending = deferred<ConversationBackend.Question>()
    const readErrors: unknown[] = []
    const subscribe = () => execution.subscribe((event) => {
      if (event.ref.threadID !== thread.id) return
      void execution.read(ref, {}).then((snapshot) => { if (snapshot.questions?.[0]) pending.resolve(snapshot.questions[0]) }, (error) => { readErrors.push(error) })
    })
    let detach = subscribe()
    cleanup.push(() => detach())
    const wire = await Transport.open(options)
    cleanup.push(() => wire.close())
    // Explicit native test setup only: production never switches Default threads to Plan to force a question.
    await wire.request("thread/settings/update", { threadId: thread.id, collaborationMode: {
      mode: "plan", settings: { model: "local-fixture", reasoning_effort: null, developer_instructions: null },
    } })
    await backend.enqueue({ ref, inputID: "question-input", text: "Ask which direction" })
    await entered.promise
    await second.resume(thread.id)
    release.resolve()
    const question = await pending.promise
    expect(question.state).toBe("pending")
    expect(question.blocking).toBe(true)
    expect(question.prompts.map((prompt) => prompt.id)).toEqual(["choice", "detail"])
    expect(question.id).not.toBe("0")
    expect(upstream.requests).toHaveLength(1)
    expect((await first.read(thread.id)).thread.status.activeFlags).toContain("waitingOnUserInput")
    const answer = { action: "answer" as const, threadID: thread.id, questionID: question.id, answers: { choice: ["Alpha"], detail: ["Keep the current layout"] } }
    expect(await backend.control({ ...answer, threadID: wrong.thread.id })).toEqual({ status: "not-found" })
    await expect(backend.control({ ...answer, answers: { choice: ["Alpha"] } })).rejects.toThrow("Invalid human input")
    await expect(backend.control({ ...answer, answers: { ...answer.answers, private: ["must-not-apply"] } })).rejects.toThrow("Invalid human input")
    await expect(backend.control({ ...answer, answers: { choice: ["Alpha", "Beta"], detail: ["Full"] } })).rejects.toThrow("Invalid human input")
    expect(upstream.requests).toHaveLength(1)
    detach()
    expect((await execution.read(ref, {})).questions).toEqual([])
    const reattached = deferred<ConversationBackend.Question>()
    detach = execution.subscribe((event) => {
      if (event.ref.threadID !== thread.id) return
      void execution.read(ref, {}).then((snapshot) => { if (snapshot.questions?.[0]) reattached.resolve(snapshot.questions[0]) }, (error) => { readErrors.push(error) })
    })
    const current = await reattached.promise
    expect(current.id).not.toBe(question.id)
    expect(await backend.control(answer)).toEqual({ status: "not-found" })
    expect(await backend.control({ ...answer, questionID: current.id })).toEqual({ status: "resolved" })
    await observer.wait(completed)
    await other.wait((event) => event.method === "serverRequest/resolved")
    expect(upstream.requests).toHaveLength(2)
    const result = upstream.requests[1].body.input?.find((item) => item.type === "function_call_output")
    expect(JSON.parse(result!.output as string)).toEqual({ answers: { choice: { answers: ["Alpha"] }, detail: { answers: ["Keep the current layout"] } } })
    expect((await execution.read(ref, {})).questions).toEqual([])
    expect(await backend.control({ ...answer, questionID: current.id })).toEqual({ status: "not-found" })
    expect((await first.queue(thread.id)).data).toEqual([])
    const nextQuestion = () => {
      const next = deferred<ConversationBackend.Question>()
      const stop = execution.subscribe((event) => {
        if (event.ref.threadID !== thread.id) return
        void execution.read(ref, {}).then((snapshot) => { if (snapshot.questions?.[0]) next.resolve(snapshot.questions[0]) }, (error) => { readErrors.push(error) })
      })
      cleanup.push(stop)
      return next.promise
    }
    const next = nextQuestion()
    await backend.enqueue({ ref, inputID: "question-dismiss", text: "Ask then dismiss" })
    const dismissed = await next
    expect(dismissed.id).not.toBe(current.id)
    expect(await backend.control({ action: "dismiss-question", threadID: thread.id, questionID: dismissed.id })).toEqual({ status: "resolved" })
    await observer.wait((event) => completed(event) && observer.events.filter(completed).length === 2)
    expect(upstream.requests).toHaveLength(4)
    const empty = upstream.requests[3].body.input?.findLast((item) => item.type === "function_call_output")
    expect(JSON.parse(empty!.output as string)).toEqual({ answers: {} })
    const last = nextQuestion()
    await backend.enqueue({ ref, inputID: "question-interrupt", text: "Ask then interrupt" })
    const interrupted = await last
    expect(await backend.control({ action: "interrupt", threadID: thread.id, turnID: interrupted.turnID })).toEqual({ status: "applied" })
    await observer.wait((event) => completed(event) && observer.events.filter(completed).length === 3)
    expect((await execution.read(ref, {})).questions).toEqual([])
    expect(await backend.control({ ...answer, questionID: interrupted.id })).toEqual({ status: "not-found" })
    expect(upstream.requests).toHaveLength(5)
    // Initial invalidation may precede native rollout creation. It is a failed read, never a fabricated idle snapshot.
    expect(readErrors.every((error) => error instanceof NativeError && error.code === -32601)).toBe(true)
    expect(upstream.requests.every(({ body }) => body.tools?.every((tool) => tool.name === "request_user_input"))).toBe(true)
  })

  test("Default mode keeps native question refusal instead of silently changing collaboration mode", async () => {
    const upstream = fixture((_, serial) => serial === 1 ? {
      id: "fc_default", call_id: "call_default", type: "function_call", name: "request_user_input", status: "completed",
      arguments: JSON.stringify({ questions: [{ id: "choice", header: "Pick", question: "Choose", options: [{ label: "Alpha", description: "First" }, { label: "Beta", description: "Second" }] }] }),
    } : reply(serial))
    const options = await managed(upstream.url)
    const adapter = await open(options.profile)
    const backend = nativeBackend(adapter)
    const detach = backend.execution!.subscribe(() => {})
    cleanup.push(detach)
    const observer = observe(adapter)
    const { thread } = await adapter.create()
    const ref = { backendID: backend.descriptor.id, threadID: thread.id }
    await backend.enqueue({ ref, inputID: "default-question", text: "Try native question" })
    await observer.wait(completed)
    expect(upstream.requests).toHaveLength(2)
    expect(text(upstream.requests[1].body)).toContain("request_user_input is unavailable in Default mode")
    expect((await backend.execution!.read(ref, {})).questions).toEqual([])
  })

  test("native queue is the only scheduler: idle launch, update, reorder, withdraw and FIFO", async () => {
    const entered = deferred<void>()
    const release = deferred<void>()
    cleanup.push(() => release.resolve())
    const upstream = fixture(async (_, serial) => {
      if (serial === 1) { entered.resolve(); await release.promise }
      return reply(serial)
    })
    const { adapter } = await start(upstream.url)
    const observer = observe(adapter)
    const { thread } = await adapter.create()
    const first = await adapter.enqueue(thread.id, "first", "first-native-input")
    expect(first.queuedSubmission.clientUserMessageId).toBe("first")
    await entered.promise
    const second = (await adapter.enqueue(thread.id, "second", "second-original")).queuedSubmission
    const duplicate = (await adapter.enqueue(thread.id, "second", "second-original")).queuedSubmission
    // The installed native API does NOT deduplicate clientUserMessageId. Record the gap;
    // never retry unknown writes or claim this experimental adapter is publication-ready.
    expect(duplicate.id).not.toBe(second.id)
    expect(await adapter.withdraw(thread.id, duplicate.id)).toEqual({ deleted: true })
    const third = (await adapter.enqueue(thread.id, "third", "third-input")).queuedSubmission
    const cancelled = (await adapter.enqueue(thread.id, "withdraw", "must-not-run")).queuedSubmission
    await adapter.update(thread.id, second.id, "second-edited")
    await adapter.reorder(thread.id, [third.id, second.id, cancelled.id])
    expect((await adapter.queue(thread.id)).data.map((item) => item.id)).toEqual([third.id, second.id, cancelled.id])
    expect(await adapter.withdraw(thread.id, cancelled.id)).toEqual({ deleted: true })
    release.resolve()
    await observer.wait((event) => completed(event) && observer.events.filter(completed).length === 3)
    expect(upstream.requests).toHaveLength(3)
    expect(text(upstream.requests[1].body)).toContain("third-input")
    expect(text(upstream.requests[1].body)).not.toContain("second-edited")
    expect(text(upstream.requests[2].body)).toContain("second-edited")
    expect(upstream.requests.every(({ body }) => !text(body).includes("must-not-run"))).toBe(true)
    expect((await adapter.queue(thread.id)).data).toEqual([])
    const turns = await adapter.turns(thread.id, { limit: 1 })
    expect(turns.data).toHaveLength(1)
    expect((await adapter.items(thread.id, turns.data[0].id as string)).data.length).toBeGreaterThan(0)
    expect(turns.nextCursor).toBeString()
    expect((await adapter.turns(thread.id, { cursor: turns.nextCursor!, limit: 10 })).data).toHaveLength(2)
  })

  test("native pending queue and history survive process exit without ID conversion or replay", async () => {
    const entered = deferred<void>()
    const release = deferred<void>()
    cleanup.push(() => release.resolve())
    const upstream = fixture(async (_, serial) => {
      if (serial === 1) { entered.resolve(); await release.promise }
      return reply(serial)
    })
    const { adapter, profile } = await start(upstream.url)
    await expect(open(profile)).rejects.toThrow("already open")
    const { thread } = await adapter.create()
    await adapter.enqueue(thread.id, "active", "interrupted-first")
    await entered.promise
    const queued = (await adapter.enqueue(thread.id, "pending", "persisted-native-pending")).queuedSubmission
    let closures = 0
    adapter.onClose(() => { closures++ })
    await adapter.close()
    await adapter.close()
    expect(closures).toBe(1)
    release.resolve()
    const resumed = await open(profile)
    const observer = observe(resumed)
    expect((await resumed.resume(thread.id)).thread.id).toBe(thread.id)
    const pending = await resumed.queue(thread.id)
    // Native startup may drain on resume; either way, this adapter never re-submits.
    expect(pending.data.every((item) => item.id === queued.id)).toBe(true)
    if (pending.data.length) await resumed.guide(thread.id, queued.id)
    await observer.wait(completed)
    expect(upstream.requests).toHaveLength(2)
    expect(text(upstream.requests[1].body)).toContain("persisted-native-pending")
    expect((await resumed.read(thread.id)).thread.id).toBe(thread.id)
    expect((await resumed.list()).data.some((item) => item.id === thread.id)).toBe(true)
    const history = await resumed.turns(thread.id)
    expect(history.data.length).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(history)).toContain("native-reply-2")
    expect(await resumed.account()).toMatchObject({ account: null, requiresOpenaiAuth: false })
    expect((await resumed.models()).data).toBeArray()
    await expect(adapter.queue(thread.id)).rejects.toBeInstanceOf(OutcomeUnknown)
  })

  test("stale steering cannot modify another turn; native interruption remains native", async () => {
    const entered = deferred<void>()
    const release = deferred<void>()
    cleanup.push(() => release.resolve())
    const upstream = fixture(async (_, serial) => {
      if (serial === 1) { entered.resolve(); await release.promise }
      return reply(serial)
    })
    const { adapter } = await start(upstream.url)
    const observer = observe(adapter)
    const { thread } = await adapter.create()
    await adapter.enqueue(thread.id, "steer-base", "native-steer-target")
    await entered.promise
    const active = await observer.wait((event) => event.method === "turn/started")
    const turnId = (active.params.turn as { id: string }).id
    await expect(adapter.steer(thread.id, "stale-turn", "stale", "must-not-apply")).rejects.toBeInstanceOf(NativeError)
    await expect(adapter.interrupt(thread.id, "stale-turn")).rejects.toBeInstanceOf(NativeError)
    expect((await adapter.execution(thread.id, {})).turn?.status).toBe("inProgress")
    expect(await adapter.steer(thread.id, turnId, "adjustment", "valid-native-adjustment")).toEqual({ turnId })
    await adapter.interrupt(thread.id, turnId)
    const end = await observer.wait(completed)
    expect((end.params.turn as { status: string }).status).toBe("interrupted")
    release.resolve()
    expect((await adapter.queue(thread.id)).data).toEqual([])
  })

  test("unadvertised shell, patch, file read, MCP and subagent tools fail in the native dispatcher", async () => {
    const injections = [
      { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "echo forbidden" }) },
      { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch\n*** Add File: forbidden.txt\n+forbidden\n*** End Patch" },
      { type: "function_call", name: "view_image", arguments: JSON.stringify({ path: "private-image.png" }) },
      { type: "function_call", name: "mcp__files__read", arguments: JSON.stringify({ path: "secret.txt" }) },
      { type: "function_call", name: "spawn_agent", arguments: JSON.stringify({ message: "read secret.txt" }) },
    ]
    const upstream = fixture((_, serial) => serial <= injections.length ? {
      ...injections[serial - 1], id: `fc_${serial}`, call_id: `call_${serial}`, status: "completed",
    } : reply(serial))
    const { adapter, profile } = await start(upstream.url)
    const sentinel = path.join(profile.workspace, "secret.txt")
    const secret = "PRIVATE-SENTINEL-NOT-IN-PROMPT-834876"
    await writeFile(sentinel, secret)
    const observer = observe(adapter)
    const { thread } = await adapter.create()
    await adapter.enqueue(thread.id, "injection", "native-tool-boundary-test")
    await observer.wait(completed)
    expect(upstream.requests).toHaveLength(injections.length + 1)
    for (const { body } of upstream.requests) {
      expect(body.tools?.map((tool) => tool.name ?? tool.type)).toEqual(["request_user_input"])
      expect(text(body)).not.toContain(secret)
    }
    const final = text(upstream.requests.at(-1)!.body)
    for (const tool of injections) expect(final).toContain(`${tool.type === "custom_tool_call" ? "unsupported custom tool call" : "unsupported call"}: ${tool.name}`)
    expect(await readFile(sentinel, "utf8")).toBe(secret)
    await expect(readFile(path.join(profile.workspace, "forbidden.txt"))).rejects.toThrow()
    expect(observer.events.some((event) => event.method.includes("commandExecution") || event.method.includes("fileChange"))).toBe(false)
  })

  test("native compaction owns its context and survives resume", async () => {
    // This compatible provider uses Codex's local summarization path, not OpenAI remote /compact.
    const upstream = fixture((_, serial) => reply(serial, serial === 2 ? "fixture-native-compacted-context" : `native-reply-${serial}`))
    const { adapter, profile } = await start(upstream.url)
    const observer = observe(adapter)
    const { thread } = await adapter.create()
    await adapter.enqueue(thread.id, "before-compact", "original-context-keep-native")
    await observer.wait(completed)
    await adapter.compact(thread.id)
    await observer.wait((event) => event.method === "thread/compacted" ||
      (event.method === "item/completed" && (event.params.item as { type: string }).type === "contextCompaction"))
    expect(upstream.requests).toHaveLength(2)
    await adapter.close()
    const resumed = await open(profile)
    const next = observe(resumed)
    await resumed.resume(thread.id)
    await resumed.enqueue(thread.id, "after-compact", "new-native-followup")
    await next.wait(completed)
    expect(text(upstream.requests.at(-1)!.body)).toContain("fixture-native-compacted-context")
    expect(text(upstream.requests.at(-1)!.body)).not.toContain("native-reply-1")
    expect((await resumed.turns(thread.id)).data.length).toBeGreaterThanOrEqual(2)
  })

  test("managed profile rejects adoption, tampering, arbitrary configuration and file input", async () => {
    const upstream = fixture()
    const { adapter, profile } = await start(upstream.url)
    await expect(createProfile(profile.home)).rejects.toThrow("existing profile")
    expect(() => nativeBackend(adapter)).toThrow("requires the shared native service")
    const { thread } = await adapter.create()
    expect(() => adapter.enqueue(thread.id, "x", { type: "localImage", path: "C:/private" } as unknown as string)).toThrow("Text input")
    expect(() => adapter.reorder(thread.id, ["x", "x"])).toThrow("Invalid queue order")
    expect(() => adapter.turns(thread.id, { limit: 0 })).toThrow("Invalid page size")
    await adapter.close()
    await writeFile(path.join(profile.home, "config.toml"), '\n[features]\nshell_tool = true\n', { flag: "a" })
    await expect(open(profile)).rejects.toThrow("revalidation required")
    expect(upstream.requests).toEqual([])
  })
})

async function managed(url: string) {
  const home = await mkdtemp(path.join(root!, "shared-"))
  const profile = await createSharedProfile(home, { id: "fixture", model: "local-fixture", baseURL: url, keyName: "IM_FIXTURE_KEY" })
  const options = { executable: executable!, profile, apiKey: "fixture-only" }
  cleanup.push(() => stopSharedService(options))
  return options
}

function worker(profile: Profile) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fixture/shared-client.ts", import.meta.url)), profile.home, executable!], {
    env: process.env, windowsHide: true, stdio: "pipe",
  })
  const messages: Record<string, unknown>[] = []
  const waiters = new Set<() => void>()
  const errors: string[] = []
  const ended = new Promise<void>((resolve) => child.once("close", () => resolve()))
  createInterface({ input: child.stdout }).on("line", (line) => {
    messages.push(JSON.parse(line))
    for (const wake of waiters) wake()
  })
  child.stderr.on("data", (data) => errors.push(String(data)))
  child.on("exit", () => { for (const wake of waiters) wake() })
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await ended
  })
  return {
    child,
    ended,
    send: (command: string) => child.stdin.write(command + "\n"),
    wait: (type: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(check); reject(new Error("Worker event deadline")) }, 20000)
      function check() {
        const message = messages.find((value) => value.type === type)
        if (message) { clearTimeout(timer); waiters.delete(check); resolve(message); return }
        if (child.exitCode !== null || child.signalCode !== null) {
          clearTimeout(timer); waiters.delete(check); reject(new Error("Worker exited: " + errors.join("").slice(-2000)))
        }
      }
      waiters.add(check)
      check()
    }),
  }
}

describe("shared native service ownership", () => {
  test("execution observations follow the native turn and pending queue without scheduling a second copy", async () => {
    const entered = deferred<void>()
    const release = deferred<void>()
    cleanup.push(() => release.resolve())
    const upstream = fixture(undefined, { entered: () => entered.resolve(), release: release.promise })
    const options = await managed(upstream.url)
    const adapter = await open(options.profile)
    const observer = observe(adapter)
    const backend = nativeBackend(adapter)
    const previews: object[] = []
    const previewed = deferred<void>()
    const unsubscribeContent = backend.content?.subscribe((event) => {
      previews.push(event)
      if (event.type === "snapshot" && event.entry.text === "native-") previewed.resolve()
      if (event.type === "append" && event.text === "native-") previewed.resolve()
    })
    if (!unsubscribeContent) throw new Error("Native content projection missing")
    cleanup.push(unsubscribeContent)
    const execution = backend.execution
    if (!execution) throw new Error("Native execution adapter missing")
    const { thread } = await adapter.create()
    const ref = { backendID: backend.descriptor.id, threadID: thread.id }
    const changes: string[] = []
    const notified = deferred<void>()
    const unsubscribe = execution.subscribe((event) => {
      expect(event.ref).toEqual(ref)
      changes.push(event.change)
      if (event.change === "both" && observer.events.filter(completed).length === 3) notified.resolve()
    })
    cleanup.push(unsubscribe)
    await backend.enqueue({ ref, inputID: "execution-first", text: "First execution" })
    await entered.promise
    await previewed.promise
    const live = await backend.browse?.history(ref, { limit: 10 })
    expect(live?.content?.items.map((item) => item.text)).toEqual(["native-"])
    const active = await execution.read(ref, { limit: 1 })
    expect(active.thread.state).toBe("running")
    expect(active.turn?.state).toBe("running")
    const started = (await observer.wait((event) => event.method === "turn/started")).params.turn
    if (!started || typeof started !== "object" || !("id" in started) || typeof started.id !== "string") throw new Error("Native turn ID missing")
    expect(active.turn?.id).toBe(started.id)
    expect(active.queue).toEqual([])
    const second = await backend.enqueue({ ref, inputID: "execution-second", text: "Second original" })
    const third = await backend.enqueue({ ref, inputID: "execution-third", text: "Third original" })
    const cancelled = await backend.enqueue({ ref, inputID: "execution-cancelled", text: "Must not execute" })
    if (!("nativeID" in second) || !("nativeID" in third) || !("nativeID" in cancelled)) throw new Error("Native queue admission rejected")
    expect(await backend.enqueue({ ref, inputID: "stale-guidance", text: "Must not steer", delivery: "steer", expectedTurnID: "stale-turn" })).toEqual({ status: "rejected", reason: "not-accepted" })
    const page = await execution.read(ref, { limit: 1 })
    expect(page.queue).toEqual([{ nativeID: second.nativeID, inputID: "execution-second", text: "Second original", partial: false }])
    expect(page.nextCursor).toBeString()
    const next = await execution.read(ref, { limit: 1, cursor: page.nextCursor })
    expect(next.queue[0].nativeID).toBe(third.nativeID)
    await backend.control({ action: "update", threadID: thread.id, nativeID: second.nativeID, text: "Second edited" })
    await backend.control({ action: "reorder", threadID: thread.id, nativeIDs: [third.nativeID, second.nativeID, cancelled.nativeID] })
    expect(await backend.control({ action: "withdraw", threadID: thread.id, nativeID: cancelled.nativeID })).toEqual({ status: "applied" })
    expect(await backend.control({ action: "withdraw", threadID: thread.id, nativeID: cancelled.nativeID })).toEqual({ status: "not-found" })
    const pending = await execution.read(ref, { limit: 10 })
    expect(pending.queue.map((entry) => entry.nativeID)).toEqual([third.nativeID, second.nativeID])
    expect(pending.queue.map((entry) => entry.text)).toEqual(["Third original", "Second edited"])
    expect(upstream.requests).toHaveLength(1)
    release.resolve()
    await observer.wait((event) => completed(event) && observer.events.filter(completed).length === 3)
    await notified.promise
    const finished = await execution.read(ref, {})
    expect(finished.turn?.state).toBe("completed")
    expect(finished.queue).toEqual([])
    expect(changes).toContain("execution")
    expect(upstream.requests).toHaveLength(3)
    expect(text(upstream.requests[1].body)).toContain("Third original")
    expect(text(upstream.requests[2].body)).toContain("Second edited")
    expect(upstream.requests.every(({ body }) => !text(body).includes("Must not execute"))).toBe(true)
    expect(upstream.requests.every(({ body }) => !text(body).includes("Must not steer"))).toBe(true)
    expect(previews.some((event) => "type" in event && event.type === "append" && "offset" in event && event.offset === 7)).toBe(true)
    expect((await backend.browse?.history(ref, {}))?.content?.items).toEqual([])
    unsubscribeContent()
    const fresh = backend.content?.subscribe(() => {})
    if (!fresh) throw new Error("Native content projection missing")
    expect((await backend.browse?.history(ref, {}))?.content?.streamID).not.toBe(live?.content?.streamID)
    fresh()
  })

  test("read-only browsing preserves native IDs and page order without resuming or reading another workspace", async () => {
    const upstream = fixture()
    const options = await managed(upstream.url)
    const adapter = await open(options.profile)
    const observer = observe(adapter)
    const { thread } = await adapter.create()
    await adapter.enqueue(thread.id, "browse-first", "first-native-record")
    await observer.wait(completed)
    await adapter.enqueue(thread.id, "browse-second", "second-native-record")
    await observer.wait((event) => completed(event) && observer.events.filter(completed).length === 2)
    const wire = await Transport.open(options)
    cleanup.push(() => wire.close())
    const foreignDirectory = await mkdtemp(path.join(root!, "foreign-"))
    const foreign = await wire.request<{ thread: { id: string } }>("thread/start", { cwd: foreignDirectory })
    const foreignCompleted = deferred<void>()
    const unsubscribe = wire.subscribe((event) => {
      if (event.method === "turn/completed" && event.params.threadId === foreign.thread.id) foreignCompleted.resolve()
    })
    await wire.request("thread/queue/add", { threadId: foreign.thread.id, clientUserMessageId: "foreign-record", input: [{ type: "text", text: "Separate test workspace" }] })
    await foreignCompleted.promise
    unsubscribe()
    await stopSharedService(options)
    const reader = await open(options.profile)
    const backend = nativeBackend(reader)
    const created = await backend.create()
    expect(created.thread.ref.backendID).toBe(backend.descriptor.id)
    expect(created.thread.ref.threadID).not.toBe(thread.id)
    expect(Object.keys(created.thread).sort()).toEqual(["ref", "state", "title", "updatedAt"])
    expect((await reader.queue(created.thread.ref.threadID)).data).toEqual([])
    const browse = backend.browse
    if (!browse) throw new Error("Native browsing adapter missing")
    const ref = { backendID: backend.descriptor.id, threadID: thread.id }
    const listed = await browse.threads({ limit: 10 })
    expect(listed.items.some((entry) => entry.ref.threadID === thread.id)).toBe(true)
    expect(listed.items.some((entry) => entry.ref.threadID === foreign.thread.id)).toBe(false)
    const latest = await browse.history(ref, { limit: 1 })
    expect(latest.thread.ref).toEqual(ref)
    expect(latest.thread.state).toBe("unloaded")
    expect(latest.items.map((entry) => entry.text)).toEqual(["native-reply-2"])
    expect(latest.nextCursor).toBeString()
    const earlier = await browse.history(ref, { limit: 1, cursor: latest.nextCursor })
    expect(earlier.items.map((entry) => entry.text)).toEqual(["second-native-record"])
    const original = await reader.items(thread.id)
    const rawID = original.data.at(-1)?.item.id
    if (typeof rawID !== "string") throw new Error("Native history ID missing")
    expect(latest.items[0].id).toBe(rawID)
    expect(earlier.items[0].turnID).toBe(original.data.at(-2)!.turnId)
    expect((await reader.read(thread.id)).thread.status.type).toBe("notLoaded")
    await expect(browse.history({ ...ref, threadID: foreign.thread.id }, {})).rejects.toThrow("another workspace")
    const execution = backend.execution
    if (!execution) throw new Error("Native execution adapter missing")
    const stopped = await execution.read(ref, {})
    expect(stopped.thread.state).toBe("unloaded")
    expect(stopped.turn?.state).toBe("completed")
    expect(stopped.queue).toEqual([])
    expect((await reader.read(thread.id)).thread.status.type).toBe("notLoaded")
    await expect(execution.read({ ...ref, threadID: foreign.thread.id }, {})).rejects.toThrow("another workspace")
    await expect(backend.query({ action: "resume", threadID: foreign.thread.id })).rejects.toThrow("another workspace")
    await expect(backend.control({ action: "compact", threadID: foreign.thread.id })).rejects.toThrow("another workspace")
    await expect(backend.enqueue({ ref: { ...ref, threadID: foreign.thread.id }, inputID: "foreign-write", text: "Must not run" })).rejects.toThrow("another workspace")
    expect(upstream.requests).toHaveLength(3)
    const active = observe(reader)
    const receipt = await backend.enqueue({ ref, inputID: "browse-explicit-send", text: "continue-original-native-thread" })
    if (!("nativeID" in receipt)) throw new Error("Native queue admission rejected")
    expect(receipt.kind).toBe("queued")
    await active.wait(completed)
    expect(upstream.requests).toHaveLength(4)
    expect(text(upstream.requests[3].body)).toContain("continue-original-native-thread")
    expect((await browse.history(ref, { limit: 1 })).items.map((entry) => entry.text)).toEqual(["native-reply-4"])
  })

  test("closing one client preserves the native running request and the other client", async () => {
    const entered = deferred<void>()
    const release = deferred<void>()
    cleanup.push(() => release.resolve())
    const upstream = fixture(async (_, serial) => {
      if (serial === 1) { entered.resolve(); await release.promise }
      return reply(serial)
    })
    const options = await managed(upstream.url)
    const first = await open(options.profile)
    const second = await open(await loadProfile(options.profile.home))
    expect(first.runtimeInfo()).toEqual(second.runtimeInfo())
    const { thread } = await first.create()
    const observer = observe(second)
    await first.enqueue(thread.id, "shared-live", "keep-running-on-disconnect")
    await entered.promise
    await second.resume(thread.id)
    await first.close()
    release.resolve()
    await observer.wait(completed)
    expect(upstream.requests).toHaveLength(1)
    expect((await second.queue(thread.id)).data).toEqual([])
    expect(await second.account()).toMatchObject({ requiresOpenaiAuth: false })
    const authentication = nativeBackend(second).authentication
    if (!authentication) throw new Error("Native authentication adapter missing")
    expect(await authentication.read()).toEqual({ state: "not-required" })
    await expect(authentication.start()).rejects.toThrow("does not use native sign-in")
    expect(await authentication.cancel("00000000-0000-0000-0000-000000000001")).toBe("not-found")
  })

  test("independent processes race to one native PID; client crash and explicit stop/restart retain native history", async () => {
    const upstream = fixture()
    const options = await managed(upstream.url)
    const first = worker(options.profile)
    const second = worker(options.profile)
    const [a, b] = await Promise.all([first.wait("ready"), second.wait("ready")])
    expect(a.pid).toBe(b.pid)
    expect(a.pid).not.toBe(first.child.pid)
    first.child.kill()
    await first.ended
    second.send("read")
    expect((await second.wait("account")).result).toMatchObject({ requiresOpenaiAuth: false })
    second.send("close")
    await second.wait("closed")
    await second.ended
    const observer = await open(options.profile)
    expect(observer.runtimeInfo().pid).toBe(Number(a.pid))
    const events = observe(observer)
    const { thread } = await observer.create()
    await observer.enqueue(thread.id, "shared-persisted", "native-history-survives-service-stop")
    await events.wait(completed)
    let closures = 0
    observer.onClose(() => { closures++ })
    expect(await stopSharedService(options)).toEqual({ status: "stopped" })
    expect(closures).toBe(1)
    expect(await stopSharedService(options)).toEqual({ status: "notRunning" })
    const restarted = await open(await loadProfile(options.profile.home))
    expect((await restarted.resume(thread.id)).thread.id).toBe(thread.id)
    expect(JSON.stringify(await restarted.turns(thread.id))).toContain("native-reply-1")
    expect(upstream.requests).toHaveLength(1)
  })

  test("a policy-mismatched native listener and a changed token are refused without approving or replacing it", async () => {
    const upstream = fixture()
    const options = await managed(upstream.url)
    const profile = options.profile
    const service = profile.service!
    const child = spawn(executable!, ["app-server", "--listen", `ws://127.0.0.1:${service.port}`,
      "--ws-auth", "capability-token", "--ws-token-file", service.tokenFile,
      ...Object.entries(policy).flatMap(([key, value]) => ["-c", `${key}=${value}`]), "-c", "features.shell_tool=true"], {
      env: { ...process.env, CODEX_HOME: profile.home, IM_FIXTURE_KEY: "fixture-only" },
      cwd: profile.workspace, windowsHide: true, stdio: "ignore",
    })
    const ended = new Promise<void>((resolve) => child.once("close", () => resolve()))
    cleanup.push(async () => { if (child.exitCode === null) child.kill(); await ended })
    const deadline = Date.now() + 10000
    let ready = false
    while (!ready && Date.now() < deadline) {
      ready = await fetch(`http://127.0.0.1:${service.port}/readyz`, { signal: AbortSignal.timeout(500) }).then((response) => response.ok, () => false)
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(ready).toBe(true)
    await expect(open(profile)).rejects.toThrow("features.shell_tool")
    await expect(stopSharedService(options)).rejects.toThrow("features.shell_tool")
    expect(child.exitCode).toBeNull()
    const token = await readFile(service.tokenFile, "utf8")
    try {
      await writeFile(service.tokenFile, "changed-token")
      await expect(open(profile)).rejects.toThrow("revalidation required")
    } finally { await writeFile(service.tokenFile, token) }
    expect(upstream.requests).toHaveLength(0)
  })

  test("racing restart clients do not replay the interrupted input or duplicate a persisted pending item", async () => {
    const entered = deferred<void>()
    const release = deferred<void>()
    cleanup.push(() => release.resolve())
    const upstream = fixture(async (_, serial) => {
      if (serial === 1) { entered.resolve(); await release.promise }
      return reply(serial)
    })
    const options = await managed(upstream.url)
    const original = await open(options.profile)
    const { thread } = await original.create()
    await original.enqueue(thread.id, "shared-interrupted", "do-not-replay-interrupted-input")
    await entered.promise
    const pending = (await original.enqueue(thread.id, "shared-pending", "run-this-native-pending-once")).queuedSubmission
    await stopSharedService(options)
    release.resolve()
    const first = worker(options.profile)
    const second = worker(options.profile)
    const [a, b] = await Promise.all([first.wait("ready"), second.wait("ready")])
    expect(a.pid).toBe(b.pid)
    expect(upstream.requests).toHaveLength(1)
    const restarted = await open(options.profile)
    const observer = observe(restarted)
    expect((await restarted.resume(thread.id)).thread.id).toBe(thread.id)
    const queue = await restarted.queue(thread.id)
    expect(queue.data.every((item) => item.id === pending.id)).toBe(true)
    if (queue.data.length) await restarted.guide(thread.id, pending.id)
    await observer.wait((event) => completed(event) && JSON.stringify(event.params.turn).includes("native-reply-2"))
    expect(upstream.requests).toHaveLength(2)
    expect(text(upstream.requests[1].body)).toContain("run-this-native-pending-once")
    expect((await restarted.queue(thread.id)).data).toEqual([])
  })

  test("shared execution still rejects forced file, shell, patch, MCP and subagent calls", async () => {
    const tools = [
      { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "echo forbidden" }) },
      { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch\n*** Add File: forbidden-shared.txt\n+forbidden\n*** End Patch" },
      { type: "function_call", name: "view_image", arguments: JSON.stringify({ path: "private-image.png" }) },
      { type: "function_call", name: "mcp__files__read", arguments: JSON.stringify({ path: "shared-secret.txt" }) },
      { type: "function_call", name: "spawn_agent", arguments: JSON.stringify({ message: "read shared-secret.txt" }) },
    ]
    const upstream = fixture((_, serial) => serial <= tools.length ? {
      ...tools[serial - 1], id: `fc_shared_${serial}`, call_id: `call_shared_${serial}`, status: "completed",
    } : reply(serial))
    const options = await managed(upstream.url)
    const adapter = await open(options.profile)
    const sentinel = path.join(options.profile.workspace, "shared-secret.txt")
    const secret = "PRIVATE-SHARED-SENTINEL-643209"
    await writeFile(sentinel, secret)
    const observer = observe(adapter)
    const { thread } = await adapter.create()
    await adapter.enqueue(thread.id, "shared-injection", "shared-boundary-test")
    await observer.wait(completed)
    expect(upstream.requests).toHaveLength(6)
    for (const { body } of upstream.requests) {
      expect(body.tools?.map((tool) => tool.name ?? tool.type)).toEqual(["request_user_input"])
      expect(text(body)).not.toContain(secret)
    }
    const final = text(upstream.requests.at(-1)!.body)
    for (const tool of tools) expect(final).toContain(`${tool.type === "custom_tool_call" ? "unsupported custom tool call" : "unsupported call"}: ${tool.name}`)
    expect(await readFile(sentinel, "utf8")).toBe(secret)
    await expect(readFile(path.join(options.profile.workspace, "forbidden-shared.txt"))).rejects.toThrow()
  })
})
