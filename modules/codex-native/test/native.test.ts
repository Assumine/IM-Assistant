import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { CodexSessionAdapter, createProfile, NativeError, OutcomeUnknown, type Notification, type Profile } from "../src"

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
function fixture(handler: Handler = (_, serial) => reply(serial)) {
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
