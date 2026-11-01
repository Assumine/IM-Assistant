import { expect } from "bun:test"
import { and, eq } from "drizzle-orm"
import { Effect, Exit, Logger, Schema } from "effect"
import { Continuation, UserPayload } from "@opencode/schema/session-inbox"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { Project } from "@opencode/schema/project"
import { Bus } from "../src/bus"
import { Database } from "../src/database/database"
import { EventTable } from "../src/event/sql"
import { ProjectTable } from "../src/project/sql"
import { AbsolutePath } from "../src/schema"
import { SessionEvent } from "../src/session/event"
import { SessionInbox } from "../src/session/inbox"
import { SessionInput } from "../src/session/input"
import { SessionOutput } from "../src/session/output"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Money } from "@opencode/schema/money"
import { SessionMessage } from "../src/session/message"
import { SessionProjector } from "../src/session/projector"
import { SessionSchema } from "../src/session/schema"
import { SessionTable, SessionMessageTable } from "../src/session/sql"
import { KVTable } from "../src/kv/sql"
import { SessionStore } from "../src/session/store"
import { tempGlobalLayer } from "./fixture/global"
import { testEffect } from "./lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Database.node, Bus.node, SessionInbox.node, SessionProjector.node, SessionStore.node]),
    { replacements: [Bus.node.replace(Bus.configured({ persist: true })), Global.node.replace(tempGlobalLayer)] },
  ),
)
const sessionID = SessionSchema.ID.make("ses_input")
const id = (value: string) => SessionMessage.ID.make("msg_" + value)
const setup = Effect.fnUntraced(function* () {
  const db = (yield* Database.Service).db,
    bus = yield* Bus.Service,
    inbox = yield* SessionInbox.Service,
    store = yield* SessionStore.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/input"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* bus.publish(SessionEvent.Created, {
    sessionID,
    projectID: Project.ID.global,
    location: { directory: AbsolutePath.make("/input") },
    slug: "input",
    version: "test",
  })
  const admit = (name: string, delivery: "queue" | "steer" = "queue") =>
    inbox.admit({ sessionID, id: id(name), item: { type: "user", payload: { text: name }, delivery } })
  const promote = (scope: SessionInbox.Promotable = "input", source = bus) =>
    SessionInbox.promote(db, source, sessionID, scope)
  const request = (name: string, expectedInputID = id("first")) => ({
    sessionID,
    id: id(name),
    expectedInputID,
    requestHash: name,
    item: { type: "user" as const, payload: { text: name, metadata: { origin: "keep" } }, delivery: "steer" as const },
  })
  const finish = () => SessionInbox.serialized(sessionID, SessionInbox.finish(db, bus, sessionID))
  return { db, bus, inbox, store, admit, promote, request, finish }
})

const followupRequest = (name: string, parent = id("first"), root = id("first")) => ({
  sessionID,
  id: id(name),
  expectedInputID: parent,
  expectedRootID: root,
  requestHash: name,
  item: { type: "user" as const, delivery: "queue" as const, payload: { text: name } },
})

const outputStep = Effect.fnUntraced(function* (bus: Bus.Interface, name: string, text: string) {
  const assistantMessageID = id(name)
  yield* bus.publish(SessionEvent.Step.Started, {
    sessionID,
    assistantMessageID,
    agent: Agent.ID.make("build"),
    model: { id: Model.ID.make("test"), providerID: Provider.ID.make("test") },
    started: 0,
  })
  yield* bus.publish(SessionEvent.Reasoning.Started, { sessionID, assistantMessageID, ordinal: 0 })
  yield* bus.publish(SessionEvent.Reasoning.Ended, {
    sessionID,
    assistantMessageID,
    ordinal: 0,
    text: "PRIVATE_REASONING",
  })
  yield* bus.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, ordinal: 1 })
  yield* bus.publish(SessionEvent.Text.Ended, { sessionID, assistantMessageID, ordinal: 1, text })
  yield* bus.publish(SessionEvent.Step.Streamed, { sessionID, assistantMessageID })
})

it.effect(
  "public input output follows native roots across steers and queued successors and omits private reasoning",
  () =>
    Effect.gen(function* () {
      const f = yield* setup()
      yield* f.admit("first")
      yield* f.admit("second")
      expect((yield* SessionOutput.read(f.db, sessionID, id("second"))).status).toBe("pending")
      yield* f.promote()
      yield* outputStep(f.bus, "reply_first", "First public reply")
      yield* f.inbox.continueInput(f.request("adjust"))
      yield* f.promote("steer")
      yield* outputStep(f.bus, "reply_final", "Final public reply")
      const open = yield* SessionOutput.read(f.db, sessionID, id("adjust"))
      expect(open.rootID).toBe(id("first"))
      expect(open.first?.text).toBe("First public reply")
      expect(open.last?.text).toBe("Final public reply")
      expect(JSON.stringify(open)).not.toContain("PRIVATE_REASONING")
      yield* f.finish()
      yield* f.promote()
      yield* outputStep(f.bus, "reply_second", "Second task reply")
      const closed = yield* SessionOutput.read(f.db, sessionID, id("first"))
      expect(closed.status).toBe("closed")
      expect(closed.last?.messageID).toBe(id("reply_final"))
      expect((yield* SessionOutput.read(f.db, sessionID, id("second"))).first?.text).toBe("Second task reply")
      yield* f.db
        .delete(SessionMessageTable)
        .where(eq(SessionMessageTable.id, id("first")))
        .run()
        .pipe(Effect.orDie)
      expect(yield* SessionOutput.read(f.db, sessionID, id("adjust"))).toEqual({
        sessionID,
        inputID: id("adjust"),
        status: "unknown",
      })
    }),
)

it.effect(
  "output ownership is replayed from native events and old unowned steps are never assigned by chronology",
  () =>
    Effect.gen(function* () {
      const f = yield* setup()
      yield* outputStep(f.bus, "legacy", "Unowned legacy response")
      yield* f.admit("first")
      yield* f.promote()
      expect((yield* SessionOutput.read(f.db, sessionID, id("first"))).first).toBeUndefined()
      yield* outputStep(f.bus, "owned", "Owned response")
      yield* f.finish()
      const events = yield* f.db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(EventTable.seq)
        .all()
        .pipe(Effect.orDie)
      yield* f.db.delete(SessionTable).run().pipe(Effect.orDie)
      yield* f.db.delete(KVTable).run().pipe(Effect.orDie)
      yield* f.bus.remove(sessionID)
      for (const event of events)
        yield* f.bus.replay({
          id: event.id,
          type: event.type,
          seq: event.seq,
          aggregateID: sessionID,
          created: event.created,
          data: event.data,
        })
      const output = yield* SessionOutput.read(f.db, sessionID, id("first"))
      expect(output.status).toBe("closed")
      expect(output.first?.messageID).toBe(id("owned"))
      expect(output.last?.text).toBe("Owned response")
      expect(JSON.stringify(output)).not.toContain("Unowned")
    }),
)

it.effect("unsettled assistant text and tool-only content are not public reply bodies", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    yield* f.admit("first")
    yield* f.promote()
    const assistantMessageID = id("partial")
    yield* f.bus.publish(SessionEvent.Step.Started, {
      sessionID,
      assistantMessageID,
      agent: Agent.ID.make("build"),
      model: { id: Model.ID.make("test"), providerID: Provider.ID.make("test") },
      started: 0,
    })
    yield* f.bus.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, ordinal: 0 })
    yield* f.bus.publish(SessionEvent.Text.Ended, { sessionID, assistantMessageID, ordinal: 0, text: "Not settled" })
    const partial = yield* SessionOutput.read(f.db, sessionID, id("first"))
    expect(partial.first).toBeUndefined()
    expect(partial.last).toEqual({ messageID: assistantMessageID, text: "", settled: false })
    yield* f.bus.publish(SessionEvent.Step.Ended, {
      sessionID,
      assistantMessageID,
      finish: "stop",
      cost: Money.USD.zero,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    expect((yield* SessionOutput.read(f.db, sessionID, id("first"))).first?.text).toBe("Not settled")
  }),
)

it.effect(
  "input observations require native close evidence and surviving user ownership; shutdown is not a close",
  () =>
    Effect.gen(function* () {
      const f = yield* setup()
      expect((yield* SessionInput.inspect(f.db, sessionID, id("absent"))).status).toBe("unknown")
      yield* f.admit("first")
      expect((yield* SessionInput.inspect(f.db, sessionID, id("first"))).status).toBe("pending")
      yield* f.promote()
      expect((yield* SessionInput.inspect(f.db, sessionID, id("first"))).status).toBe("open")
      yield* f.bus.publish(SessionEvent.Execution.Interrupted, { sessionID, reason: "shutdown" })
      expect((yield* SessionInput.inspect(f.db, sessionID, id("first"))).status).toBe("open")
      yield* f.finish()
      expect(yield* SessionInput.inspect(f.db, sessionID, id("first"))).toEqual({
        sessionID,
        inputID: id("first"),
        rootID: id("first"),
        status: "closed",
      })
      yield* f.db
        .delete(SessionMessageTable)
        .where(eq(SessionMessageTable.id, id("first")))
        .run()
        .pipe(Effect.orDie)
      expect((yield* SessionInput.inspect(f.db, sessionID, id("first"))).status).toBe("unknown")
    }),
)

it.effect("linked follow-ups enqueue once behind existing work and open their own native boundary", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    yield* f.admit("first")
    yield* f.promote()
    yield* f.finish()
    yield* f.admit("second")
    yield* f.admit("third")
    yield* f.promote()
    const request = followupRequest("linked")
    yield* Effect.all(
      Array.from({ length: 6 }, () => f.inbox.followupInput(request)),
      { concurrency: "unbounded" },
    )
    expect((yield* f.inbox.list(sessionID)).map((row) => row.id)).toEqual([id("third"), id("linked")])
    expect((yield* SessionInput.current(f.db, sessionID))?.rootID).toBe(id("second"))
    yield* f.finish()
    yield* f.promote()
    yield* f.finish()
    yield* f.promote()
    expect((yield* SessionInput.current(f.db, sessionID))?.rootID).toBe(id("linked"))
    expect((yield* f.inbox.followup(request)).status).toBe("delivered")
    expect((yield* f.inbox.followupInput(request)).status).toBe("delivered")
    expect(yield* f.inbox.list(sessionID)).toHaveLength(0)
  }),
)

it.effect("unknown, open, wrong-root and pruned historical inputs cannot create follow-up work", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    yield* f.admit("first")
    yield* f.promote()
    expect(Exit.isFailure(yield* f.inbox.followupInput(followupRequest("open")).pipe(Effect.exit))).toBe(true)
    yield* f.finish()
    for (const request of [
      followupRequest("missing", id("absent")),
      followupRequest("wrong", id("first"), id("wrong")),
      followupRequest("first"),
    ])
      expect(Exit.isFailure(yield* f.inbox.followupInput(request).pipe(Effect.exit))).toBe(true)
    yield* f.bus.publish(SessionEvent.RevertEvent.Staged, { sessionID, revert: { messageID: id("first") } })
    expect(Exit.isFailure(yield* f.inbox.followupInput(followupRequest("staged_revert")).pipe(Effect.exit))).toBe(true)
    yield* f.bus.publish(SessionEvent.RevertEvent.Cleared, { sessionID })
    expect((yield* f.inbox.followup(followupRequest("unknown"))).status).toBe("unknown")
    expect((yield* SessionInput.inspect(f.db, sessionID, id("first"))).status).toBe("closed")
    yield* f.db
      .delete(SessionMessageTable)
      .where(eq(SessionMessageTable.id, id("first")))
      .run()
      .pipe(Effect.orDie)
    expect(Exit.isFailure(yield* f.inbox.followupInput(followupRequest("after_prune")).pipe(Effect.exit))).toBe(true)
    expect(yield* f.inbox.list(sessionID)).toHaveLength(0)
  }),
)

it.effect(
  "cancelled follow-up identity cannot be reused by ordinary, continuation or changed follow-up admission",
  () =>
    Effect.gen(function* () {
      const f = yield* setup()
      yield* f.admit("first")
      yield* f.promote()
      yield* f.finish()
      const request = followupRequest("linked")
      yield* f.inbox.followupInput(request)
      yield* f.inbox.cancel({ sessionID, id: request.id })
      expect((yield* f.inbox.followupInput(request)).status).toBe("cancelled")
      expect(
        Exit.isFailure(yield* f.inbox.followupInput({ ...request, requestHash: "changed" }).pipe(Effect.exit)),
      ).toBe(true)
      expect(Exit.isFailure(yield* f.admit("linked").pipe(Effect.exit))).toBe(true)
      yield* f.admit("second")
      yield* f.promote()
      expect(Exit.isFailure(yield* f.inbox.continueInput(f.request("linked", id("second"))).pipe(Effect.exit))).toBe(
        true,
      )
      expect((yield* SessionInput.inspect(f.db, sessionID, id("first"))).status).toBe("closed")
    }),
)

it.effect("follow-up receipt, Inbox row and event log roll back in the same native transaction", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    yield* f.admit("first")
    yield* f.promote()
    yield* f.finish()
    yield* f.bus.project(SessionEvent.InboxEnqueued, (event) =>
      event.data.followup ? Effect.die(new Error("Synthetic follow-up rollback")) : Effect.void,
    )
    const before = yield* f.db
      .select()
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, sessionID))
      .all()
      .pipe(Effect.orDie)
    expect(
      Exit.isFailure(
        yield* f.inbox.followupInput(followupRequest("linked")).pipe(Effect.provide(Logger.layer([])), Effect.exit),
      ),
    ).toBe(true)
    expect((yield* f.inbox.followup(followupRequest("linked"))).status).toBe("unknown")
    expect(yield* f.inbox.list(sessionID)).toHaveLength(0)
    expect(
      yield* f.db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all().pipe(Effect.orDie),
    ).toHaveLength(before.length)
  }),
)

it.effect("durable replay rebuilds close evidence and linked follow-up receipts without native execution", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    yield* f.admit("first")
    yield* f.promote()
    yield* f.finish()
    yield* f.inbox.followupInput(followupRequest("delivered"))
    yield* f.promote()
    yield* f.finish()
    yield* f.inbox.followupInput(followupRequest("cancelled"))
    yield* f.inbox.cancel({ sessionID, id: id("cancelled") })
    const events = yield* f.db
      .select()
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, sessionID))
      .orderBy(EventTable.seq)
      .all()
      .pipe(Effect.orDie)
    yield* f.db.delete(SessionTable).run().pipe(Effect.orDie)
    yield* f.db.delete(KVTable).run().pipe(Effect.orDie)
    yield* f.bus.remove(sessionID)
    for (const event of events)
      yield* f.bus.replay({
        id: event.id,
        type: event.type,
        seq: event.seq,
        aggregateID: sessionID,
        created: event.created,
        data: event.data,
      })
    expect((yield* SessionInput.inspect(f.db, sessionID, id("first"))).status).toBe("closed")
    expect((yield* f.inbox.followup(followupRequest("delivered"))).status).toBe("delivered")
    expect((yield* f.inbox.followup(followupRequest("cancelled"))).status).toBe("cancelled")
    expect(yield* f.inbox.list(sessionID)).toHaveLength(0)
  }),
)

it.effect(
  "input ownership follows queue boundaries and all delivered steers, not the execution busy period or latest user",
  () =>
    Effect.gen(function* () {
      const f = yield* setup()
      yield* f.admit("first")
      yield* f.admit("second")
      yield* f.promote()
      expect(Exit.isFailure(yield* f.inbox.continueInput(f.request("future", id("second"))).pipe(Effect.exit))).toBe(
        true,
      )
      yield* f.bus.publish(SessionEvent.Execution.Started, { sessionID })
      yield* f.admit("ordinary_steer", "steer")
      yield* f.promote("steer")
      expect(yield* SessionInput.belongs(f.db, sessionID, id("first"))).toBe(id("first"))
      expect(yield* SessionInput.belongs(f.db, sessionID, id("ordinary_steer"))).toBe(id("first"))
      const nested = f.request("nested", id("ordinary_steer"))
      expect((yield* f.inbox.continueInput(nested)).rootID).toBe(id("first"))
      yield* f.promote("steer")
      yield* f.finish()
      yield* f.promote()
      expect(yield* SessionInput.belongs(f.db, sessionID, id("first"))).toBeUndefined()
      expect(yield* SessionInput.belongs(f.db, sessionID, id("ordinary_steer"))).toBeUndefined()
      expect(yield* SessionInput.belongs(f.db, sessionID, id("second"))).toBe(id("second"))
      expect(Exit.isFailure(yield* f.inbox.continueInput(f.request("late")).pipe(Effect.exit))).toBe(true)
      expect((yield* f.store.messages({ sessionID })).filter((item) => item.type === "idle")).toHaveLength(0)
      yield* f.db
        .delete(SessionMessageTable)
        .where(eq(SessionMessageTable.id, id("second")))
        .run()
        .pipe(Effect.orDie)
      expect(Exit.isFailure(yield* f.inbox.continueInput(f.request("pruned", id("second"))).pipe(Effect.exit))).toBe(
        true,
      )
    }),
)

it.effect(
  "parallel duplicate continuations retain one native steer and one receipt, including after delivery and close",
  () =>
    Effect.gen(function* () {
      const f = yield* setup()
      yield* f.admit("first")
      yield* f.admit("second")
      yield* f.promote()
      const request = f.request("adjust")
      const receipts = yield* Effect.all(
        Array.from({ length: 8 }, () => f.inbox.continueInput(request)),
        { concurrency: "unbounded" },
      )
      expect(receipts.every((entry) => entry.status === "pending" && entry.rootID === id("first"))).toBe(true)
      expect((yield* f.inbox.list(sessionID)).map((row) => row.id)).toEqual([id("second"), id("adjust")])
      yield* f.finish()
      expect((yield* SessionInput.current(f.db, sessionID))?.rootID).toBe(id("first"))
      yield* f.promote("steer")
      expect((yield* f.inbox.continuation(request)).status).toBe("delivered")
      yield* f.finish()
      yield* f.promote()
      expect((yield* f.inbox.continueInput(request)).status).toBe("delivered")
      expect((yield* f.store.messages({ sessionID })).filter((row) => row.id === id("adjust"))).toHaveLength(1)
      expect((yield* SessionInput.current(f.db, sessionID))?.rootID).toBe(id("second"))
    }),
)

it.effect("unknown and conflicting receipts never admit, retarget or wake work", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    yield* f.admit("first")
    yield* f.promote()
    const request = f.request("adjust")
    expect((yield* f.inbox.continuation(request)).status).toBe("unknown")
    expect(yield* f.inbox.list(sessionID)).toHaveLength(0)
    yield* f.inbox.continueInput(request)
    for (const changed of [
      { ...request, requestHash: "changed" },
      { ...request, expectedInputID: id("other") },
    ])
      expect(Exit.isFailure(yield* f.inbox.continueInput(changed).pipe(Effect.exit))).toBe(true)
    yield* f.inbox.cancel({ sessionID, id: request.id })
    expect((yield* f.inbox.continueInput(request)).status).toBe("cancelled")
    expect(yield* f.inbox.list(sessionID)).toHaveLength(0)
  }),
)

it.effect(
  "user stop, failure and completion expire only unconsumed guarded steers; shutdown preserves the original intent",
  () =>
    Effect.gen(function* () {
      const f = yield* setup()
      for (const outcome of ["shutdown", "failed", "stopped", "completed"] as const) {
        const root = id("root_" + outcome),
          adjust = id("adjust_" + outcome)
        yield* f.admit("root_" + outcome)
        yield* f.promote()
        yield* f.inbox.continueInput({ ...f.request("adjust_" + outcome, root), id: adjust })
        yield* f.admit("next_" + outcome)
        if (outcome === "failed")
          yield* f.bus.publish(SessionEvent.Execution.Failed, { sessionID, error: { type: "test", message: "failed" } })
        else if (outcome === "completed") yield* f.bus.publish(SessionEvent.Execution.Succeeded, { sessionID })
        else
          yield* f.bus.publish(SessionEvent.Execution.Interrupted, {
            sessionID,
            reason: outcome === "shutdown" ? "shutdown" : "user",
          })
        expect((yield* f.inbox.continuation({ sessionID, id: adjust, expectedInputID: root })).status).toBe(
          outcome === "shutdown" ? "pending" : "expired",
        )
        expect((yield* f.inbox.list(sessionID)).some((row) => row.id === id("next_" + outcome))).toBe(true)
        if (outcome === "shutdown") {
          expect((yield* SessionInput.current(f.db, sessionID))?.rootID).toBe(root)
          yield* f.promote("steer")
        } else expect((yield* f.store.messages({ sessionID })).some((row) => row.id === adjust)).toBe(false)
        yield* f.promote()
        yield* f.finish()
      }
    }),
)

it.effect("guarded steers cannot be moved to another queued task or resurrected through ordinary admission", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    yield* f.admit("first")
    yield* f.promote()
    const request = f.request("adjust")
    yield* f.inbox.continueInput(request)
    expect(Exit.isFailure(yield* f.inbox.queue({ sessionID, id: request.id }).pipe(Effect.exit))).toBe(true)
    yield* f.bus.publish(SessionEvent.Execution.Interrupted, { sessionID, reason: "user" })
    expect((yield* f.inbox.continueInput(request)).status).toBe("expired")
    expect(Exit.isFailure(yield* f.admit("adjust").pipe(Effect.exit))).toBe(true)
    expect(yield* f.inbox.list(sessionID)).toHaveLength(0)
  }),
)

it.effect(
  "a continuation racing a selected queue delivery aborts that boundary and is delivered to its original input first",
  () =>
    Effect.gen(function* () {
      const f = yield* setup()
      yield* f.admit("first")
      yield* f.promote()
      yield* f.admit("second")
      let raced = false
      const source: Bus.Interface = {
        ...f.bus,
        publish: (definition, data, options) =>
          Effect.gen(function* () {
            if (definition.type === SessionEvent.InboxDelivered.type && !raced) {
              raced = true
              // Another process can commit admission while the local Inbox lock is held. Use the same durable transaction boundary.
              yield* f.bus.publish(SessionEvent.InboxEnqueued, {
                sessionID,
                inboxID: id("racing"),
                item: f.request("racing").item,
                continuation: { expectedInputID: id("first"), requestHash: "racing" },
              })
            }
            return yield* f.bus.publish(definition, data, options)
          }),
      }
      expect(yield* f.promote("input", source)).toBeUndefined()
      expect((yield* f.inbox.continuation({ sessionID, id: id("racing"), expectedInputID: id("first") })).status).toBe(
        "pending",
      )
      expect((yield* f.store.messages({ sessionID })).some((row) => row.id === id("second"))).toBe(false)
      yield* f.promote()
      expect((yield* SessionInput.current(f.db, sessionID))?.rootID).toBe(id("first"))
      yield* f.finish()
      yield* f.promote()
      expect((yield* f.store.context(sessionID)).filter((row) => row.type === "user").map((row) => row.id)).toEqual([
        id("first"),
        id("racing"),
        id("second"),
      ])
    }),
)

it.effect("a continuation racing an input close prevents closing, and a stale close cannot affect a successor", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    yield* f.admit("first")
    yield* f.promote()
    yield* f.inbox.continueInput(f.request("racing"))
    const result = yield* f.bus.publish(SessionEvent.InputClosed, { sessionID, rootID: id("first") }).pipe(Effect.exit)
    expect(Exit.isFailure(result)).toBe(true)
    yield* f.promote("steer")
    yield* f.finish()
    yield* f.admit("second")
    yield* f.promote()
    yield* f.bus.publish(SessionEvent.InputClosed, { sessionID, rootID: id("first") })
    expect((yield* SessionInput.current(f.db, sessionID))?.rootID).toBe(id("second"))
  }),
)

it.effect("continuation receipt and Inbox row roll back together if another projector fails", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    yield* f.admit("first")
    yield* f.promote()
    yield* f.bus.project(SessionEvent.InboxEnqueued, (event) =>
      event.data.continuation ? Effect.die(new Error("Synthetic transaction failure")) : Effect.void,
    )
    const before = yield* f.db
      .select()
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, sessionID))
      .all()
      .pipe(Effect.orDie)
    expect(
      Exit.isFailure(
        yield* f.inbox.continueInput(f.request("adjust")).pipe(Effect.provide(Logger.layer([])), Effect.exit),
      ),
    ).toBe(true)
    expect((yield* f.inbox.continuation(f.request("adjust"))).status).toBe("unknown")
    expect(yield* f.inbox.list(sessionID)).toHaveLength(0)
    expect(
      yield* f.db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all().pipe(Effect.orDie),
    ).toHaveLength(before.length)
  }),
)

it.effect("durable event replay rebuilds native ownership and historical continuation receipts", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    yield* f.admit("first")
    yield* f.promote()
    yield* f.inbox.continueInput(f.request("adjust"))
    yield* f.promote("steer")
    yield* f.finish()
    const events = yield* f.db
      .select()
      .from(EventTable)
      .where(and(eq(EventTable.aggregate_id, sessionID)))
      .orderBy(EventTable.seq)
      .all()
      .pipe(Effect.orDie)
    // This test owns the whole temporary database. Rebuild the projections from the durable log, not caller commit callbacks.
    yield* f.db.delete(SessionTable).run().pipe(Effect.orDie)
    yield* f.db.delete(KVTable).run().pipe(Effect.orDie)
    yield* f.bus.remove(sessionID)
    for (const event of events)
      yield* f.bus.replay({
        id: event.id,
        type: event.type,
        seq: event.seq,
        aggregateID: sessionID,
        created: event.created,
        data: event.data,
      })
    expect((yield* f.inbox.continuation({ sessionID, id: id("adjust"), expectedInputID: id("first") })).status).toBe(
      "delivered",
    )
    expect(yield* SessionInput.current(f.db, sessionID)).toBeUndefined()
  }),
)

it.effect("wire contracts omit unknown roots and ordinary payloads cannot forge a guarded continuation", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    const receipt = yield* f.inbox.continuation(f.request("unknown"))
    expect(Schema.encodeSync(Continuation)(receipt)).toEqual({
      sessionID,
      inboxID: id("unknown"),
      expectedInputID: id("first"),
      status: "unknown",
    })
    expect(Schema.encodeSync(UserPayload)(UserPayload.make({ text: "ordinary" }))).toEqual({ text: "ordinary" })
    expect(
      Exit.isFailure(
        yield* f.inbox
          .admit({
            sessionID,
            id: id("forged"),
            item: { type: "user", delivery: "steer", payload: { text: "forged", continuationOf: id("first") } },
          })
          .pipe(Effect.exit),
      ),
    ).toBe(true)
    expect(yield* f.inbox.list(sessionID)).toHaveLength(0)
  }),
)
