import { expect } from "bun:test"
import { and, eq } from "drizzle-orm"
import { DateTime, Effect, Exit, Logger } from "effect"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { Project } from "@opencode/schema/project"
import { Event } from "@opencode/schema/event"
import { Bus } from "../src/bus"
import { Database } from "../src/database/database"
import { EventTable } from "../src/event/sql"
import { ProjectTable } from "../src/project/sql"
import { AbsolutePath } from "../src/schema"
import { SessionEvent } from "../src/session/event"
import { SessionInbox } from "../src/session/inbox"
import { SessionMessage } from "../src/session/message"
import { SessionProjector } from "../src/session/projector"
import { SessionSchema } from "../src/session/schema"
import { SessionInboxTable } from "../src/session/sql"
import { SessionStore } from "../src/session/store"
import { tempGlobalLayer } from "./fixture/global"
import { testEffect } from "./lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Database.node, Bus.node, SessionInbox.node, SessionProjector.node, SessionStore.node]),
    {
      replacements: [Bus.node.replace(Bus.configured({ persist: true })), Global.node.replace(tempGlobalLayer)],
    },
  ),
)
const sessionID = SessionSchema.ID.make("ses_append")
const setup = Effect.fnUntraced(function* () {
  const db = (yield* Database.Service).db
  const bus = yield* Bus.Service
  const inbox = yield* SessionInbox.Service
  const store = yield* SessionStore.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/append"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* bus.publish(SessionEvent.Created, {
    sessionID,
    projectID: Project.ID.global,
    location: { directory: AbsolutePath.make("/append") },
    slug: "append",
    version: "test",
  })
  const admit = (name: string, delivery: "queue" | "steer" = "queue") =>
    inbox.admit({
      sessionID,
      id: SessionMessage.ID.make("msg_" + name),
      item: {
        type: "user",
        payload: {
          text: name,
          metadata: { origin: "unchanged" },
          agents: [],
          files: [{ data: "cHJlc2VydmVk", mime: "text/plain", source: { type: "inline" }, name: "keep.txt" }],
        },
        delivery,
      },
    })
  const events = () =>
    db
      .select()
      .from(EventTable)
      .where(
        and(
          eq(EventTable.aggregate_id, sessionID),
          eq(EventTable.type, Bus.versionedType(SessionEvent.InboxTextAppended.type, 1)),
        ),
      )
      .all()
      .pipe(Effect.orDie)
  return { db, bus, inbox, store, admit, events }
})

it.effect("concurrent duplicate append changes one original pending row once without moving it", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    const first = yield* f.admit("first", "steer")
    yield* f.admit("second")
    const before = yield* f.db.select().from(SessionInboxTable).all().pipe(Effect.orDie)
    const request = {
      sessionID,
      id: first.id,
      amendmentID: SessionMessage.ID.make("msg_append_one"),
      text: "  Keep this exact whitespace  ",
    }
    const results = yield* Effect.all(
      Array.from({ length: 8 }, () => f.inbox.append(request)),
      { concurrency: "unbounded" },
    )
    expect(results.every((entry) => entry.status === "applied")).toBe(true)
    const after = yield* f.inbox.list(sessionID)
    expect(after.map((entry) => entry.id)).toEqual([first.id, SessionMessage.ID.make("msg_second")])
    expect(after[0]).toMatchObject({
      id: first.id,
      delivery: "steer",
      payload: {
        text: "first\n\n  Keep this exact whitespace  ",
        metadata: { origin: "unchanged" },
        agents: [],
        files: [{ data: "cHJlc2VydmVk", mime: "text/plain", source: { type: "inline" }, name: "keep.txt" }],
      },
    })
    const rows = yield* f.db.select().from(SessionInboxTable).all().pipe(Effect.orDie)
    expect(rows.map((row) => [row.id, row.enqueued_seq, row.time_created, row.delivery])).toEqual(
      before.map((row) => [row.id, row.enqueued_seq, row.time_created, row.delivery]),
    )
    expect(yield* f.events()).toHaveLength(1)
  }),
)

it.effect("distinct append operations serialize while reused IDs cannot change target or text", () =>
  Effect.gen(function* () {
    const f = yield* setup(),
      first = yield* f.admit("first"),
      second = yield* f.admit("second")
    const request = { sessionID, id: first.id, amendmentID: SessionMessage.ID.make("msg_distinct"), text: "one" }
    yield* f.inbox.append(request)
    expect(Exit.isFailure(yield* f.inbox.append({ ...request, text: "changed" }).pipe(Effect.exit))).toBe(true)
    expect(Exit.isFailure(yield* f.inbox.append({ ...request, id: second.id }).pipe(Effect.exit))).toBe(true)
    expect(
      Exit.isFailure(
        yield* f.inbox.amendment({ ...request, sessionID: SessionSchema.ID.make("ses_other") }).pipe(Effect.exit),
      ),
    ).toBe(true)
    yield* Effect.all(
      ["two", "three"].map((text) =>
        f.inbox.append({ ...request, amendmentID: SessionMessage.ID.make("msg_" + text), text }),
      ),
      { concurrency: "unbounded" },
    )
    const text = (yield* f.inbox.list(sessionID))[0]
    const events = yield* f.events()
    expect(text.type === "user" && text.payload.text).toBe(
      "first\n\n" + events.map((event) => event.data.text).join("\n\n"),
    )
    expect(events).toHaveLength(3)
  }),
)

it.effect("append and promotion share the native boundary, never changing an already delivered input", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    for (const order of ["append-first", "deliver-first", "concurrent"] as const) {
      const item = yield* f.admit(order)
      const request = {
        sessionID,
        id: item.id,
        amendmentID: SessionMessage.ID.make("msg_amend_" + order),
        text: "supplement",
      }
      let applied: boolean
      if (order === "append-first") {
        yield* f.inbox.append(request)
        yield* SessionInbox.promote(f.db, f.bus, sessionID, "input")
        applied = true
      } else if (order === "deliver-first") {
        yield* SessionInbox.promote(f.db, f.bus, sessionID, "input")
        applied = Exit.isSuccess(yield* f.inbox.append(request).pipe(Effect.exit))
      } else {
        const result = yield* Effect.all(
          [
            f.inbox.append(request).pipe(Effect.exit),
            SessionInbox.promote(f.db, f.bus, sessionID, "input").pipe(Effect.exit),
          ],
          { concurrency: "unbounded" },
        )
        applied = Exit.isSuccess(result[0])
      }
      const stored = (yield* f.store.context(sessionID)).find((message) => message.id === item.id)
      expect(stored?.type === "user" && stored.text).toBe(order + (applied ? "\n\nsupplement" : ""))
      expect((yield* f.inbox.amendment(request)).status).toBe(applied ? "applied" : "unknown")
      expect(yield* f.inbox.list(sessionID)).toEqual([])
    }
  }),
)

it.effect("durable receipts survive consumption and cancellation without a second append or admission", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    for (const outcome of ["delivered", "cancelled"]) {
      const item = yield* f.admit(outcome)
      const request = {
        sessionID,
        id: item.id,
        amendmentID: SessionMessage.ID.make("msg_amend_" + outcome),
        text: "one",
      }
      yield* f.inbox.append(request)
      if (outcome === "delivered") yield* SessionInbox.promote(f.db, f.bus, sessionID, "input")
      else yield* f.inbox.cancel(request)
      expect((yield* f.inbox.append(request)).status).toBe("applied")
      expect((yield* f.inbox.amendment(request)).status).toBe("applied")
      expect(
        Exit.isFailure(
          yield* f.inbox
            .append({ ...request, amendmentID: SessionMessage.ID.make("msg_new_" + outcome) })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
    }
    expect(yield* f.events()).toHaveLength(2)
    expect(yield* f.inbox.list(sessionID)).toEqual([])
  }),
)

it.effect("failed payload or receipt writes roll back the entire event and allow a safe explicit retry", () =>
  Effect.gen(function* () {
    const f = yield* setup(),
      item = yield* f.admit("original")
    const request = { sessionID, id: item.id, amendmentID: SessionMessage.ID.make("msg_rollback"), text: "only once" }
    for (const table of ["kv", "session_inbox"]) {
      yield* f.db.run(
        `CREATE TRIGGER reject_append BEFORE ${table === "kv" ? "INSERT" : "UPDATE"} ON ${table} BEGIN SELECT RAISE(ABORT, 'append write failure'); END`,
      )
      expect(
        Exit.isFailure(
          yield* f.inbox.append(request).pipe(Effect.exit, Effect.provideService(Logger.CurrentLoggers, new Set())),
        ),
      ).toBe(true)
      yield* f.db.run("DROP TRIGGER reject_append")
      expect((yield* f.inbox.amendment(request)).status).toBe("unknown")
      expect(yield* f.events()).toHaveLength(0)
      expect((yield* f.inbox.list(sessionID))[0]).toMatchObject({ payload: { text: "original" } })
    }
    expect((yield* f.inbox.append(request)).status).toBe("applied")
    expect(yield* f.events()).toHaveLength(1)
  }),
)

it.effect("native event replay rebuilds both pending text and its receipt without a caller commit hook", () =>
  Effect.gen(function* () {
    const f = yield* setup(),
      item = yield* f.admit("replayed")
    const amendmentID = SessionMessage.ID.make("msg_replay_append")
    const event = {
      id: Event.ID.create(),
      type: Bus.versionedType(SessionEvent.InboxTextAppended.type, 1),
      aggregateID: sessionID,
      seq: (yield* Bus.latestSequence(f.db, sessionID)) + 1,
      created: DateTime.toEpochMillis(item.time.created),
      data: { sessionID, inboxID: item.id, amendmentID, text: "from durable log" },
    }
    yield* f.bus.replay(event)
    yield* f.bus.replay(event)
    expect((yield* f.inbox.amendment({ sessionID, id: item.id, amendmentID })).status).toBe("applied")
    expect((yield* f.inbox.list(sessionID))[0]).toMatchObject({ payload: { text: "replayed\n\nfrom durable log" } })
  }),
)
