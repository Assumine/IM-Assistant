import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { OpenCode } from "@opencode/client"
import type { ApplicationModule } from "@opencode/plugin/promise/application"
import { Effect, Exit, Scope } from "effect"
import { ServerFetch } from "../src/fetch"

type ModuleContext = Parameters<ApplicationModule["open"]>[0]
async function boot(modules: readonly ApplicationModule[]) {
  const directory = await mkdtemp(path.join(tmpdir(), "application-modules-"))
  const scope = Effect.runSync(Scope.make())
  try {
    const handler = await Effect.runPromise(
      ServerFetch.make(
        {
          database: { path: ":memory:" },
          models: { fetch: false },
          config: { directory, project: false, claude: false },
          runtime: { managedDirectory: directory },
          fs: { filewatcher: false },
        },
        { modules },
      ).pipe(Effect.provideService(Scope.Scope, scope)),
    )
    const fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init)), {
      preconnect: () => undefined,
    })
    const client = OpenCode.make({ baseUrl: "http://opencode.test", fetch })
    return {
      client,
      directory,
      close: async () => {
        await Effect.runPromise(Scope.close(scope, Exit.void))
        await rm(directory, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

test("application resources open once while native sessions and Location capabilities are read repeatedly", async () => {
  let opens = 0,
    closes = 0
  const app = await boot([
    {
      id: "observer",
      open() {
        opens++
        return {
          close: async () => {
            closes++
          },
        }
      },
    },
  ])
  try {
    for (const title of ["First", "Second"]) {
      const session = await app.client.session.create({ title, location: { directory: app.directory } })
      await app.client.session.get({ sessionID: session.id })
      await app.client.permission.list({ sessionID: session.id })
    }
    expect(opens).toBe(1)
  } finally {
    await app.close()
  }
  expect(closes).toBe(1)
}, 30000)

test("modules reuse isolated original plugin storage and close before their public clients and native database are released", async () => {
  const contexts = new Map<string, ModuleContext>(),
    closing: string[] = []
  const app = await boot(
    ["alpha", "beta"].map(
      (id): ApplicationModule => ({
        id,
        open(context) {
          contexts.set(id, context)
          return {
            close: async () => {
              await context.storage.insert("closed", true)
              await context.client.session.list()
              closing.push(id)
            },
          }
        },
      }),
    ),
  )
  await contexts.get("alpha")!.storage.set("same-key", "alpha")
  await contexts.get("beta")!.storage.set("same-key", "beta")
  expect(await contexts.get("alpha")!.storage.get("same-key")).toBe("alpha")
  expect(await contexts.get("beta")!.storage.get("same-key")).toBe("beta")
  await app.close()
  expect(closing.sort()).toEqual(["alpha", "beta"])
  for (const context of contexts.values()) {
    await expect(context.storage.get("same-key")).rejects.toThrow("closed")
    await expect(context.client.session.list()).rejects.toThrow()
  }
}, 30000)

test("a failing optional open is isolated, fences its escaped context and does not prevent another module or core session", async () => {
  let failed: ModuleContext | undefined,
    healthy = 0,
    closed = 0
  const app = await boot([
    {
      id: "broken",
      open(context) {
        failed = context
        throw new Error("Do not log raw module configuration")
      },
    },
    {
      id: "healthy",
      open() {
        healthy++
        return {
          close: async () => {
            closed++
          },
        }
      },
    },
  ])
  try {
    expect(healthy).toBe(1)
    await expect(failed!.storage.get("private")).rejects.toThrow("closed")
    await expect(failed!.client.session.list()).rejects.toThrow()
    expect((await app.client.session.create({ location: { directory: app.directory } })).id).toStartWith("ses_")
  } finally {
    await app.close()
  }
  expect(closed).toBe(1)
}, 30000)

test("duplicate identities are not started twice and cleanup failure does not skip other owners", async () => {
  let opens = 0,
    closes = 0
  const app = await boot([
    {
      id: "single",
      open() {
        opens++
        return {
          close: async () => {
            closes++
            throw new Error("Synthetic cleanup failure")
          },
        }
      },
    },
    {
      id: "single",
      open() {
        throw new Error("Duplicate must not start")
      },
    },
    {
      id: "other",
      open() {
        return {
          close: async () => {
            closes++
          },
        }
      },
    },
  ])
  expect(opens).toBe(1)
  await app.close()
  expect(closes).toBe(2)
}, 30000)
