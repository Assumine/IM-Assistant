import { describe, expect } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Money } from "@opencode/schema/money"
import { Project } from "@opencode/schema/project"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/schema/session"
import { SessionEvent } from "@opencode/schema/session-event"
import { SessionMessage } from "@opencode/schema/session-message"
import { AbsolutePath } from "@opencode/core/schema"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { ProjectTable } from "@opencode/core/project/sql"
import { SessionMessageTable, SessionTable } from "@opencode/core/session/sql"
import { SessionStats } from "@opencode/core/session/stats"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { DateTime, Effect, Schema } from "effect"
import { TestClock } from "effect/testing"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node]), [
    Bus.node.replace(Bus.configured({ retain: [SessionEvent.UsageRecorded] })),
  ]),
)
const projectID = Project.ID.make("stats-project")
const otherProjectID = Project.ID.make("stats-other-project")
const sessionID = Session.ID.make("ses_stats_root")
const childID = Session.ID.make("ses_stats_child")
const forkID = Session.ID.make("ses_stats_fork")
const usageOnlyID = Session.ID.make("ses_stats_usage_only")
const otherSessionID = Session.ID.make("ses_stats_other")
const encodeMessage = Schema.encodeSync(SessionMessage.Info)

describe("SessionStats", () => {
  it.effect("counts auxiliary-only usage by its actual range, project and model without inventing attribution for old records", () => Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const bus = yield* Bus.Service
    yield* db.insert(ProjectTable).values([
      { id: projectID, worktree: AbsolutePath.make("/stats"), sandboxes: [] },
      { id: otherProjectID, worktree: AbsolutePath.make("/other"), sandboxes: [] },
    ]).run().pipe(Effect.orDie)
    yield* db.insert(SessionTable).values([
      { id: sessionID, project_id: projectID, slug: "aux", directory: "/stats", version: "test" },
      { id: otherSessionID, project_id: otherProjectID, slug: "other", directory: "/other", version: "test" },
      { id: forkID, project_id: projectID, slug: "fork", directory: "/stats", version: "test", fork_session_id: sessionID, time_created: 4000 },
    ]).run().pipe(Effect.orDie)
    const model = { providerID: Provider.ID.make("local"), id: Model.ID.make("aux-model") }
    const usage = { cost: Money.USD.zero, tokens: { input: 2, output: 3, reasoning: 0, cache: { read: 0, write: 0 },
      provenance: { input: true, output: true, reasoning: true, cacheRead: true, cacheWrite: true, cost: "reported" as const } } }
    yield* TestClock.setTime(500)
    yield* bus.publish(SessionEvent.UsageRecorded, { ...usage, sessionID: otherSessionID, model, source: "title" })
    yield* bus.publish(SessionEvent.UsageRecorded, { ...usage, sessionID: forkID, model, source: "compaction" })
    yield* TestClock.setTime(1000)
    yield* bus.publish(SessionEvent.UsageRecorded, { ...usage, sessionID, model, source: "title" })
    yield* TestClock.setTime(2000)
    yield* bus.publish(SessionEvent.UsageRecorded, { ...usage, sessionID, model, source: "generate" })
    // An older auxiliary event is still counted, but has no proven model or reporting metadata.
    yield* bus.publish(SessionEvent.UsageRecorded, { sessionID, source: "compaction", cost: Money.USD.zero,
      tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
    const all = yield* SessionStats.get({ projectID, to: 3000, tools: "none" })
    expect(DateTime.toEpochMillis(all.range.from)).toBe(1000)
    expect(all.tokens).toEqual({ input: 5, output: 6, reasoning: 0, cache: { read: 0, write: 0 } })
    expect(all.reporting).toMatchObject({ records: 3, complete: 2, cost: { reported: { records: 2, amount: 0 }, unknown: { records: 1, amount: 0 } } })
    expect(all.steps).toBe(0)
    expect(all.models).toHaveLength(1)
    expect(all.models[0]).toMatchObject({ model, steps: 0, tokens: { input: 4, output: 6 }, reporting: { records: 2, complete: 2 } })
    const recent = yield* SessionStats.get({ projectID, from: 1500, to: 3000, tools: "none" })
    expect(recent.tokens.input).toBe(3)
    expect(recent.reporting.records).toBe(2)
    expect(recent.models[0].reporting.records).toBe(1)
  }))

  it.effect("keeps reporting coverage and price sources across time ranges and legacy rows", () => Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db.insert(ProjectTable).values({ id: projectID, worktree: AbsolutePath.make("/stats"), sandboxes: [] }).run().pipe(Effect.orDie)
    yield* db.insert(SessionTable).values({ id: sessionID, project_id: projectID, slug: "reporting", directory: "/stats", version: "test" }).run().pipe(Effect.orDie)
    const start = Date.UTC(2026, 0, 2)
    const legacy = assistant("msg_reporting_legacy", start - 1, [])
    const zero = SessionMessage.Assistant.make({ ...assistant("msg_reporting_zero", start, []), cost: Money.USD.zero,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 },
        provenance: { input: true, output: true, reasoning: true, cacheRead: true, cacheWrite: true, cost: "reported" } } })
    const partial = SessionMessage.Assistant.make({ ...assistant("msg_reporting_partial", start + 1, []),
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 20, write: 0 },
        provenance: { input: true, output: true, reasoning: false, cacheRead: true, cacheWrite: false, cost: "catalog" } } })
    yield* db.insert(SessionMessageTable).values([messageRow(sessionID, 1, legacy), messageRow(sessionID, 2, zero), messageRow(sessionID, 3, partial)]).run().pipe(Effect.orDie)
    const current = yield* SessionStats.get({ from: start, to: start + 2, tools: "none" })
    expect(current.reporting.records).toBe(2)
    expect(current.reporting.complete).toBe(1)
    expect(current.reporting.fields).toEqual({ input: 2, output: 2, reasoning: 1, cacheRead: 2, cacheWrite: 1 })
    expect(current.reporting.cost.reported).toEqual({ records: 1, amount: 0 })
    expect(current.reporting.cost.catalog).toEqual({ records: 1, amount: 1.5 })
    expect(current.reporting.cost.unknown.records).toBe(0)
    expect(current.models[0].reporting).toEqual(current.reporting)
    const all = yield* SessionStats.get({ to: start + 2, tools: "none" })
    expect(all.reporting.records).toBe(3)
    expect(all.reporting.complete).toBe(1)
    expect(all.reporting.fields).toEqual(current.reporting.fields)
    expect(all.reporting.cost.unknown).toEqual({ records: 1, amount: 1.5 })
    const empty = yield* SessionStats.get({ from: start + 2, to: start + 3, tools: "none" })
    expect(empty.reporting.records).toBe(0)
    expect(empty.reporting.cost.reported).toEqual({ records: 0, amount: 0 })
  }))
  it.effect("aggregates activity and tool reliability without reading message payloads outside the range", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db
        .insert(ProjectTable)
        .values([
          { id: projectID, worktree: AbsolutePath.make("/stats"), name: "stats", sandboxes: [] },
          { id: otherProjectID, worktree: AbsolutePath.make("/other"), name: "other", sandboxes: [] },
        ])
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values([
          { id: sessionID, project_id: projectID, slug: "root", directory: "/stats", version: "test" },
          {
            id: childID,
            project_id: projectID,
            parent_id: sessionID,
            slug: "child",
            directory: "/stats",
            version: "test",
          },
          {
            id: forkID,
            project_id: projectID,
            fork_session_id: sessionID,
            slug: "fork",
            directory: "/stats",
            version: "test",
            time_created: Date.UTC(2026, 0, 4),
          },
          { id: usageOnlyID, project_id: projectID, slug: "usage", directory: "/stats", version: "test" },
          { id: otherSessionID, project_id: otherProjectID, slug: "other", directory: "/other", version: "test" },
        ])
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values([
          messageRow(
            sessionID,
            1,
            SessionMessage.User.make({
              id: SessionMessage.ID.make("msg_stats_user"),
              type: "user",
              text: "hello",
              time: { created: DateTime.makeUnsafe(Date.UTC(2026, 0, 2, 9)) },
            }),
          ),
          messageRow(
            sessionID,
            2,
            assistant("msg_stats_assistant", Date.UTC(2026, 0, 2, 10), [
              SessionMessage.AssistantTool.make({
                type: "tool",
                id: "call_read",
                name: "read",
                state: SessionMessage.ToolStateCompleted.make({
                  status: "completed",
                  input: {},
                  content: [{ type: "text", text: "ok" }],
                }),
                time: {
                  created: DateTime.makeUnsafe(Date.UTC(2026, 0, 2, 10)),
                  ran: DateTime.makeUnsafe(Date.UTC(2026, 0, 2, 10, 0, 1)),
                  completed: DateTime.makeUnsafe(Date.UTC(2026, 0, 2, 10, 0, 1, 250)),
                },
              }),
              SessionMessage.AssistantTool.make({
                type: "tool",
                id: "call_edit",
                name: "edit",
                state: SessionMessage.ToolStateError.make({
                  status: "error",
                  input: {},
                  error: { type: "tool", message: "failed" },
                }),
                time: {
                  created: DateTime.makeUnsafe(Date.UTC(2026, 0, 2, 10)),
                  completed: DateTime.makeUnsafe(Date.UTC(2026, 0, 2, 10, 0, 2)),
                },
              }),
              SessionMessage.AssistantTool.make({
                type: "tool",
                id: "call_pending",
                name: "pending",
                state: SessionMessage.ToolStateRunning.make({ status: "running", input: {}, metadata: {} }),
                time: { created: DateTime.makeUnsafe(Date.UTC(2026, 0, 2, 10)) },
              }),
            ]),
          ),
          messageRow(childID, 1, assistant("msg_stats_child", Date.UTC(2026, 0, 3, 10), [], "large", 2)),
          messageRow(
            forkID,
            1,
            SessionMessage.User.make({
              id: SessionMessage.ID.make("msg_stats_fork_copied_user"),
              type: "user",
              text: "copied",
              time: { created: DateTime.makeUnsafe(Date.UTC(2026, 0, 2, 9)) },
            }),
          ),
          messageRow(
            forkID,
            2,
            assistant("msg_stats_fork_copied_assistant", Date.UTC(2026, 0, 2, 10), [
              SessionMessage.AssistantTool.make({
                type: "tool",
                id: "call_copied",
                name: "copied",
                state: SessionMessage.ToolStateCompleted.make({
                  status: "completed",
                  input: {},
                  content: [{ type: "text", text: "copied" }],
                }),
                time: {
                  created: DateTime.makeUnsafe(Date.UTC(2026, 0, 2, 10)),
                  completed: DateTime.makeUnsafe(Date.UTC(2026, 0, 2, 10, 0, 1)),
                },
              }),
            ]),
          ),
          messageRow(forkID, 3, assistant("msg_stats_fork_new", Date.UTC(2026, 0, 5, 10), [], "fork-new")),
          messageRow(sessionID, 3, assistant("msg_stats_outside", Date.UTC(2025, 11, 31, 10), [])),
          messageRow(usageOnlyID, 1, assistant("msg_stats_usage_only", Date.UTC(2025, 11, 30, 10), [])),
          messageRow(otherSessionID, 1, assistant("msg_stats_other", Date.UTC(2020, 0, 1, 10), [])),
        ])
        .run()
        .pipe(Effect.orDie)
      // Publish through the real Bus so the stored event type is whatever the
      // writer persists rather than a string the test assumes.
      const bus = yield* Bus.Service
      yield* TestClock.setTime(Date.UTC(2026, 0, 2, 10, 0, 3))
      yield* bus.publish(SessionEvent.UsageRecorded, {
        sessionID,
        source: "title",
        model: { id: Model.ID.make("sonnet"), providerID: Provider.ID.make("anthropic") },
        cost: Money.USD.make(0.5),
        tokens: { input: 1, output: 1, reasoning: 1, cache: { read: 1, write: 1 } },
      })
      yield* bus.publish(SessionEvent.UsageRecorded, {
        sessionID: usageOnlyID,
        source: "compaction",
        cost: Money.USD.make(0.25),
        tokens: { input: 2, output: 2, reasoning: 2, cache: { read: 2, write: 2 } },
      })

      const stats = yield* SessionStats.get({
        from: Date.UTC(2026, 0, 1),
        to: Date.UTC(2026, 1, 1),
        timezone: "UTC",
        tools: "detail",
      })

      expect(stats.sessions).toBe(2)
      expect(stats.subagents).toBe(1)
      expect(stats.prompts).toBe(1)
      expect(stats.steps).toBe(3)
      expect(stats.tokens).toEqual({ input: 43, output: 23, reasoning: 11, cache: { read: 19, write: 7 } })
      expect(stats.cost).toBe(Money.USD.make(6.75))
      expect(stats.models.find(model => model.model.id === "sonnet")).toMatchObject({
        steps: 1, cost: 2, tokens: { input: 11, output: 6, reasoning: 3, cache: { read: 5, write: 2 } },
      })
      expect(stats.tools).toMatchObject({
        mode: "detail",
        totals: { calls: 3, succeeded: 1, failed: 1, unfinished: 1 },
      })
      expect(stats.activity).toEqual([
        { date: "2026-01-02", steps: 1 },
        { date: "2026-01-03", steps: 1 },
        { date: "2026-01-05", steps: 1 },
      ])
      expect(stats.streak).toBe(2)
      expect(stats.models.map((model) => String(model.model.id))).toEqual(["large", "sonnet", "fork-new"])
      expect(stats.tools.mode).toBe("detail")
      if (stats.tools.mode !== "detail") throw new Error("Expected detailed tool statistics")
      expect(stats.tools.usage).toMatchObject([
        { name: "read", calls: 1, succeeded: 1, failed: 0, durationP50: 250 },
        { name: "edit", calls: 1, succeeded: 0, failed: 1, durationP50: 2_000 },
        { name: "pending", calls: 1, succeeded: 0, failed: 0, unfinished: 1 },
      ])

      const summary = yield* SessionStats.get({
        from: Date.UTC(2026, 0, 1),
        to: Date.UTC(2026, 1, 1),
        timezone: "UTC",
      })
      expect(summary.models.map((model) => String(model.model.id))).toEqual(["large", "sonnet", "fork-new"])
      expect(summary.tools).toEqual({
        mode: "summary",
        totals: { calls: 3, succeeded: 1, failed: 1, unfinished: 1 },
      })

      const withoutTools = yield* SessionStats.get({
        from: Date.UTC(2026, 0, 1),
        to: Date.UTC(2026, 1, 1),
        timezone: "UTC",
        tools: "none",
      })
      expect(withoutTools.tools).toEqual({ mode: "none" })

      const project = yield* SessionStats.get({ projectID, timezone: "UTC", tools: "none" })
      expect(DateTime.toEpochMillis(project.range.from)).toBe(Date.UTC(2025, 11, 30, 10))

      const error = yield* Effect.flip(
        SessionStats.get({ from: Date.UTC(2026, 1, 1), to: Date.UTC(2026, 0, 1), tools: "none" }),
      )
      expect(error).toEqual(
        new SessionStats.InvalidRangeError({ from: Date.UTC(2026, 1, 1), to: Date.UTC(2026, 0, 1) }),
      )

      const future = yield* Effect.flip(SessionStats.get({ from: Number.MAX_SAFE_INTEGER, tools: "none" }))
      expect(future._tag).toBe("SessionStats.InvalidRangeError")
    }),
  )
})

function assistant(
  id: string,
  created: number,
  content: SessionMessage.AssistantContent[],
  model = "sonnet",
  scale = 1,
) {
  return SessionMessage.Assistant.make({
    id: SessionMessage.ID.make(id),
    type: "assistant",
    agent: Agent.ID.make("build"),
    model: { id: Model.ID.make(model), providerID: Provider.ID.make("anthropic") },
    content,
    cost: Money.USD.make(1.5 * scale),
    tokens: { input: 10 * scale, output: 5 * scale, reasoning: 2 * scale, cache: { read: 4 * scale, write: scale } },
    time: { created: DateTime.makeUnsafe(created), completed: DateTime.makeUnsafe(created + 2_000) },
  })
}

function messageRow(
  sessionID: Session.ID,
  seq: number,
  message: SessionMessage.Info,
): typeof SessionMessageTable.$inferInsert {
  const encoded = encodeMessage(message)
  const { id, type, ...data } = encoded
  return { id: SessionMessage.ID.make(id), session_id: sessionID, type, seq, time_created: encoded.time.created, data }
}
