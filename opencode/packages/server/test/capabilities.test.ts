import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { OpenCode } from "@opencode/client"
import { Capability } from "@opencode/schema/capability"
import type { ApplicationModule, ApplicationModuleEntry } from "@opencode/plugin/promise/application"
import { Effect, Exit, Scope } from "effect"
import { ServerFetch } from "../src/fetch"

type ModuleContext = Parameters<ApplicationModule["open"]>[0]

async function boot(modules: readonly ApplicationModuleEntry[], existing?: string) {
  const directory = existing ?? (await mkdtemp(path.join(tmpdir(), "capabilities-")))
  const scope = Effect.runSync(Scope.make())
  const close = async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    if (!existing) await rm(directory, { recursive: true, force: true })
  }
  try {
    const handler = await Effect.runPromise(
      ServerFetch.make(
        {
          database: { path: existing ? path.join(existing, "native.sqlite") : ":memory:" },
          models: { fetch: false },
          config: { directory, project: false, claude: false },
          runtime: { managedDirectory: directory },
          fs: { filewatcher: false },
        },
        { modules },
      ).pipe(Effect.provideService(Scope.Scope, scope)),
    )
    const fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        const response = await handler(request)
        if (response.status >= 500) console.error(request.url, response.status, await response.clone().text())
        return response
      },
      { preconnect: () => undefined },
    )
    const client = OpenCode.make({
      baseUrl: "http://capability.test",
      headers: { "x-opencode-directory": encodeURIComponent(directory) },
      fetch,
    })
    return { client, api: client.rpc(Capability.Api), directory, close }
  } catch (error) {
    await close()
    throw error
  }
}

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Capability observation deadline")
    await Bun.sleep(5)
  }
}

test("empty applications expose metadata without a QQ login, module, monitor or native task", async () => {
  const app = await boot([])
  try {
    expect(await app.api.list({})).toEqual([])
    expect(await app.api.notifications({})).toEqual({ items: [], counts: { unread: 0, attention: 0 } })
    expect(await app.api.metrics({ id: "absent" })).toEqual({ id: "absent", status: "unavailable", items: [] })
    await expect(app.api.stop({ id: "absent" })).rejects.toThrow()
    expect((await app.client.session.create({ location: { directory: app.directory } })).id).toStartWith("ses_")
  } finally {
    await app.close()
  }
}, 30000)

test("slow and failing configuration stay isolated and stopping a loader fences its late result", async () => {
  const pending = Promise.withResolvers<ApplicationModule | undefined>()
  let lateOpens = 0,
    closed = 0
  let healthy: ModuleContext | undefined
  const app = await boot([
    { id: "slow", load: () => pending.promise },
    {
      id: "bad-config",
      load: async () => {
        throw new Error("Private synthetic configuration must not be returned")
      },
    },
    { id: "off", load: async () => undefined },
    {
      id: "healthy",
      open(context) {
        healthy = context
        return {
          close: async () => {
            closed++
          },
        }
      },
    },
  ])
  try {
    await until(async () => (await app.api.list({})).find((row) => row.id === "bad-config")?.state === "failed")
    const states = new Map((await app.api.list({})).map((row) => [row.id, row.state]))
    expect(states).toEqual(
      new Map([
        ["slow", "loading"],
        ["bad-config", "failed"],
        ["off", "disabled"],
        ["healthy", "active"],
      ]),
    )
    expect((await app.client.session.create({ location: { directory: app.directory } })).id).toStartWith("ses_")
    expect((await app.api.stop({ id: "slow" })).state).toBe("stopped")
    pending.resolve({
      id: "slow",
      open() {
        lateOpens++
        return { close: async () => {} }
      },
    })
    await pending.promise
    await app.api.list({})
    expect(lateOpens).toBe(0)
    healthy!.capability.report({ phase: "degraded", message: "One optional upstream is unavailable" })
    expect((await app.api.list({})).find((row) => row.id === "healthy")?.health?.phase).toBe("degraded")
    const stopped = await Promise.all([app.api.stop({ id: "healthy" }), app.api.stop({ id: "healthy" })])
    expect(stopped.every((item) => item.health === undefined)).toBe(true)
    expect(closed).toBe(1)
    expect(() => healthy!.capability.report({ phase: "ready" })).toThrow("closed")
    await expect(
      healthy!.capability.notify({ id: "late", title: "Late", severity: "info", requiresAction: false }),
    ).rejects.toThrow("closed")
    expect((await app.client.session.create({ location: { directory: app.directory } })).id).toStartWith("ses_")
  } finally {
    pending.resolve(undefined)
    await app.close()
  }
}, 30000)

test("unread and outstanding action remain separate across native SQLite restart and module namespaces", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "capability-notice-persistence-"))
  const contexts = new Map<string, ModuleContext>()
  const modules: ApplicationModule[] = ["alpha", "beta"].map((id) => ({
    id,
    open(context) {
      contexts.set(id, context)
      return { close: async () => {} }
    },
  }))
  let app = await boot(modules, directory)
  try {
    const a = contexts.get("alpha")!.capability,
      b = contexts.get("beta")!.capability
    const first = {
      id: "same",
      title: "Needs manual input",
      message: "Read is not resolution",
      severity: "warning" as const,
      requiresAction: true,
    }
    await Promise.all([
      a.notify(first),
      a.notify(first),
      b.notify({ ...first, title: "Independent module notice", requiresAction: false }),
    ])
    expect((await app.api.notifications({})).counts).toEqual({ unread: 2, attention: 1 })
    const read = await app.api.markRead({ moduleID: "alpha", id: "same" })
    expect(read.readAt).toBeNumber()
    expect(read.resolvedAt).toBeUndefined()
    expect((await app.api.notifications({ filter: "attention" })).items.map((row) => row.moduleID)).toEqual(["alpha"])
    await b.resolve("same")
    expect((await app.api.notifications({})).counts).toEqual({ unread: 1, attention: 1 })
    await expect(a.notify({ ...first, title: "Must not overwrite the original" })).rejects.toThrow()
    await expect(app.api.markRead({ moduleID: "alpha", id: "unknown" })).rejects.toThrow()
    expect((await app.api.notifications({})).items.find((row) => row.moduleID === "alpha")?.title).toBe(first.title)
    await app.close()
    app = await boot(modules, directory)
    expect((await app.api.notifications({})).counts).toEqual({ unread: 1, attention: 1 })
    await contexts.get("alpha")!.capability.resolve("same")
    await contexts
      .get("beta")!
      .capability.notify({ ...first, title: "Independent module notice", requiresAction: false })
    expect((await app.api.notifications({})).counts).toEqual({ unread: 1, attention: 0 })
    await app.api.markRead({ moduleID: "beta", id: "same" })
    expect((await app.api.notifications({})).counts).toEqual({ unread: 0, attention: 0 })
    await app.close()
    app = await boot([], directory)
    expect(await app.api.list({})).toEqual([])
    expect((await app.api.notifications({})).items).toHaveLength(2)
    expect((await app.api.notifications({})).counts).toEqual({ unread: 0, attention: 0 })
  } finally {
    await app.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)

test("notification pagination and unread filtering use native metadata order with stable cursor ties", async () => {
  const contexts = new Map<string, ModuleContext>()
  const app = await boot(
    ["alpha", "beta"].map((id) => ({
      id,
      open(context) {
        contexts.set(id, context)
        return { close: async () => {} }
      },
    })),
  )
  try {
    await Promise.all(
      ["alpha", "beta"].flatMap((moduleID) =>
        ["one", "two", "three"].map((id) =>
          contexts.get(moduleID)!.capability.notify({ id, title: id, requiresAction: false, severity: "info" }),
        ),
      ),
    )
    let cursor: Capability.NoticeQuery["cursor"]
    const rows: Capability.Notice[] = []
    do {
      const page = await app.api.notifications({ limit: 2, cursor })
      rows.push(...page.items)
      cursor = page.next
    } while (cursor)
    expect(rows).toHaveLength(6)
    expect(new Set(rows.map((row) => row.moduleID + ":" + row.id)).size).toBe(6)
    expect(rows).toEqual(
      [...rows].sort(
        (a, b) => b.createdAt - a.createdAt || (a.moduleID + ":" + a.id).localeCompare(b.moduleID + ":" + b.id),
      ),
    )
    for (const row of rows.slice(0, 2)) await app.api.markRead(row)
    const unread = await app.api.notifications({ filter: "unread", limit: 100 })
    expect(unread.items).toHaveLength(4)
    expect(unread.counts).toEqual({ unread: 4, attention: 0 })
  } finally {
    await app.close()
  }
}, 30000)

test("metrics are opt-in, coalesced while in flight and cancelled when only their owning capability stops", async () => {
  const sample = Promise.withResolvers<readonly Capability.Metric[]>()
  let calls = 0,
    signal: AbortSignal | undefined
  const app = await boot([
    {
      id: "observer",
      open() {
        return {
          close: async () => {},
          metrics: async (input) => {
            calls++
            signal = input
            return sample.promise
          },
        }
      },
    },
    {
      id: "no-metrics",
      open() {
        return { close: async () => {} }
      },
    },
  ])
  try {
    await app.api.list({})
    await app.api.notifications({})
    expect(calls).toBe(0)
    expect((await app.api.metrics({ id: "no-metrics" })).status).toBe("unsupported")
    const results = Promise.all([app.api.metrics({ id: "observer" }), app.api.metrics({ id: "observer" })])
    await until(async () => calls === 1)
    sample.resolve([{ id: "jobs", label: "Owned jobs", value: 0, unit: "count" }])
    expect((await results).map((row) => row.status)).toEqual(["ready", "ready"])
    expect(calls).toBe(1)
    await app.api.stop({ id: "observer" })
    expect(signal?.aborted).toBe(true)
    expect((await app.api.metrics({ id: "observer" })).status).toBe("unavailable")
    expect(calls).toBe(1)
    expect((await app.api.list({})).find((row) => row.id === "no-metrics")?.state).toBe("active")
  } finally {
    sample.resolve([])
    await app.close()
  }
}, 30000)
