// Interactive, isolated live-source proof. The calling agent authors the function through real MCP tools.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import path from "node:path"
import { createInterface } from "node:readline"
import { Effect, Exit, Scope } from "effect"
import { OpenCode } from "@opencode/client"
import { Capability } from "@opencode/schema/capability"
import { ServerFetch } from "../src/fetch"
import { createResearchModule, jsonCollector, type Draft, type Identity } from "../../../../modules/research/src/index"
import { Client, StreamableHTTPClientTransport } from "../../../../modules/research/test/mcp-client"

const root = process.env.IM_RESEARCH_PUBLIC_TEST_ROOT
if (!root) throw new Error("Use an isolated research-public-test profile")
const replay = process.env.IM_RESEARCH_PUBLIC_TEST_REPLAY === "1"
await mkdir(root, { recursive: true })
const home = await mkdtemp(path.join(root, "public-branch-")), directory = path.join(home, "location")
await mkdir(directory); await mkdir(path.join(home, "config"))
const sourceURL = "https://api.github.com/repos/browser-act/skills"
const source = jsonCollector({ baseURL: "https://api.github.com" })
const reads: { finishedAt: string; outcome: string }[] = []
const research = createResearchModule({ primitives: [{ ...source, async execute(input, context) {
  const output = await source.execute(input, context)
  reads.push({ finishedAt: new Date().toISOString(), outcome: output.status })
  return output
} }] })
const scope = Effect.runSync(Scope.make())
let server: ReturnType<typeof Bun.serve> | undefined, endpoint: ReturnType<typeof Bun.serve> | undefined
const clients: Client[] = []
const records: { caller: string; tool: string; input: unknown; output: unknown; sourceReads: number }[] = []
const toolErrors: string[] = []
let draft: Draft | undefined
const emit = (value: unknown) => console.log("RESEARCH_CONSOLE " + JSON.stringify(value))
function object(value: unknown): Record<string, unknown> {
  assert(value && typeof value === "object" && !Array.isArray(value))
  return value as Record<string, unknown>
}
try {
  const handler = await Effect.runPromise(ServerFetch.make({ database: { path: path.join(home, "native.sqlite") }, models: { fetch: false },
    config: { directory: path.join(home, "config"), project: false, claude: false,
      content: JSON.stringify({ update: "disable", share: "disabled", providers: {} }) },
    runtime: { managedDirectory: directory }, fs: { filewatcher: false },
  }, { modules: [research] }).pipe(Effect.provideService(Scope.Scope, scope)))
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => handler(request) })
  const native = OpenCode.make({ baseUrl: `http://127.0.0.1:${server.port}`, headers: { "x-opencode-directory": encodeURIComponent(directory) } })
  await native.rpc(Capability.Api).list({}); await research.ready
  const assistance = await native.session.create({ title: "Public branch test assistance identity", location: { directory } })
  const runner = await native.session.create({ title: "Public branch test execution identity", location: { directory } })
  const actors = new Map<string, Identity>([
    [randomUUID(), { backendID: "opencode", threadID: assistance.id }],
    [randomUUID(), { backendID: "opencode", threadID: runner.id }],
  ])
  endpoint = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: research.mcp(async (token) => actors.get(token)) })
  for (const token of actors.keys()) {
    const client = new Client({ name: "current-agent-public-branch-test", version: "1.0.0" })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${endpoint.port}/mcp`), {
      requestInit: { headers: { authorization: "Bearer " + token } },
    }))
  }
  assert.equal((await clients[0]!.listTools()).tools.length, 10)
  emit({ status: "ready", source: sourceURL, minimumIntervalMs: 5000, privateReportDirectory: home })
  const definition = replay ? await Bun.file(path.resolve(import.meta.dir, "../../../../modules/research/examples/github-repository.json")).json() as Draft : undefined
  const run = { caller: "runner", tool: "research_run", arguments: { roundID: "public-github-round", category: "misc", action: "repository-metadata", input: { repository: "browser-act/skills" } } }
  const commands = replay ? [
    { caller: "assistance", tool: "research_identity", arguments: {} },
    { caller: "assistance", tool: "research_adopt", arguments: { expectedVersion: 0 } },
    { caller: "assistance", tool: "research_paths", arguments: {} },
    { caller: "assistance", tool: "research_probe", arguments: { primitiveID: "read_json", input: { path: "/repos/browser-act/skills" } } },
    { caller: "assistance", tool: "research_save", arguments: { definition } },
    { caller: "assistance", tool: "research_test", arguments: { testID: "public-github-test", pathID: definition!.id, revision: definition!.revision, input: { repository: "browser-act/skills" } } },
    { caller: "assistance", tool: "research_publish", arguments: { pathID: definition!.id, revision: definition!.revision, testID: "public-github-test" } },
    run, run, { finish: true },
  ].map((command) => JSON.stringify(command)) : createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of commands) {
    if (!line.trim()) continue
    try {
      const command = object(JSON.parse(line))
      if (command.finish === true) {
        assert(draft, "An MCP-authored draft is required")
        const names = records.map((record) => record.tool)
        for (const name of ["research_adopt", "research_probe", "research_save", "research_test", "research_publish", "research_run"])
          assert(names.includes(name), "Missing actual tool call: " + name)
        const runs = records.filter((record) => record.tool === "research_run" && record.caller === "runner")
        assert.equal(runs.length, 2, "Run then repeat the same round")
        assert.equal(object(runs[0]!.output).status, "success")
        assert.deepEqual(runs[0]!.output, runs[1]!.output)
        assert.equal(runs[0]!.sourceReads, runs[1]!.sourceReads, "A duplicate must not revisit the source")
        const output = object(object(runs[0]!.output).output)
        assert.equal(output.fullName, "browser-act/skills")
        assert.equal(output.pageURL, "https://github.com/browser-act/skills")
        assert.equal(typeof output.defaultBranch, "string")
        assert.equal(reads.length, 3, "Exactly probe, test and first execution must collect")
        assert(reads.every((read) => read.outcome === "success"))
        const report = { schemaVersion: 1, status: "passed", verifiedAt: new Date().toISOString(),
          scope: "one-live-public-json-branch-not-a-complete-research-workflow", sourceURL,
          authoring: replay ? "replay-of-agent-authored-example" : "current-agent-over-official-mcp-client",
          execution: "separate-test-identity-runs-published-function", toolErrors,
          sourceReads: reads, sourceRequestCount: reads.length, duplicateExtraSourceRequests: 0, modelApiRequests: 0,
          temporaryNativeIdentities: 2, productionSwitch: false,
          checks: ["official MCP authentication and tool negotiation", "role adoption by a temporary native identity",
            "live public source probe", "agent-authored immutable draft tested with source I/O",
            "publication of the exact tested revision", "published function reused by a separate test identity",
            "duplicate round returns its receipt without another source read"],
          toolCalls: records.map((record) => ({ caller: record.caller, tool: record.tool,
            status: object(record.output).status ?? "returned", sourceReads: record.sourceReads })), output,
          limitations: ["No browser or login flow exercised", "No model inference launched by the test host",
            "No whole movie/music workflow", "No persistent partial-trunk checkpoint verification"],
        }
        await writeFile(path.join(home, "proof.json"), JSON.stringify(report, null, 2) + "\n")
        await writeFile(path.join(home, "draft.json"), JSON.stringify(draft, null, 2) + "\n")
        emit({ status: "passed", proof: path.join(home, "proof.json"), report })
        break
      }
      assert(command.caller === "assistance" || command.caller === "runner", "Select a test identity")
      assert(typeof command.tool === "string" && command.tool.startsWith("research_"), "Select a research tool")
      const input = object(command.arguments ?? {})
      const result = await clients[command.caller === "assistance" ? 0 : 1]!.callTool({ name: command.tool, arguments: input })
      assert(!result.isError, "Research tool failed: " + JSON.stringify(result.content))
      assert(Array.isArray(result.content))
      const text = result.content.find((part) => part.type === "text")
      assert(text?.type === "text")
      const output: unknown = JSON.parse(text.text)
      records.push({ caller: command.caller, tool: command.tool, input, output, sourceReads: reads.length })
      await writeFile(path.join(home, "private-transcript.json"), JSON.stringify(records, null, 2) + "\n")
      if (command.tool === "research_save") draft = input.definition as Draft
      emit({ id: command.id, status: "returned", tool: command.tool, output, sourceReads: reads.length })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toolErrors.push(message)
      emit({ status: "error", error: message })
      if (replay) throw error
    }
  }
} finally {
  process.stdin.destroy()
  await Promise.all(clients.map((client) => client.close()))
  endpoint?.stop(true)
  await Effect.runPromise(Scope.close(scope, Exit.void))
  server?.stop(true)
}
