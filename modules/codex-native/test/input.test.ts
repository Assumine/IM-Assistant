import { expect, test } from "bun:test"
import { nativeBackend } from "../src/backend"
import type { CodexSessionAdapter, ItemEntry, Submission, Turn } from "../src/session-adapter"

const ref = { backendID: "codex-native", threadID: "native-thread" }
function fixture() {
  const calls: string[] = []
  const queued = new Map<string | undefined, { data: Submission[]; nextCursor: string | null }>()
  const history = new Map<string | undefined, { data: ItemEntry[]; nextCursor: string | null }>()
  const turns = new Map<string | undefined, { data: Turn[]; nextCursor: string | null }>()
  const enqueued: unknown[] = []
  const adapter = {
    runtimeInfo: () => ({ mode: "shared" }),
    readOwned: async () => { calls.push("ownership"); return { status: { type: "active" } } },
    queue: async (_id: string, page: { cursor?: string }) => { calls.push("queue"); return queued.get(page.cursor) ?? { data: [], nextCursor: null } },
    items: async (_id: string, _turn: string | undefined, page: { cursor?: string }) => { calls.push("history"); return history.get(page.cursor) ?? { data: [], nextCursor: null } },
    turnStates: async (_id: string, page: { cursor?: string }) => { calls.push("turns"); return turns.get(page.cursor) ?? { data: [{ id: "turn-original", status: "inProgress" }], nextCursor: null } },
    enqueue: async (...args: unknown[]) => { enqueued.push(args); return { queuedSubmission: { id: "new-native-pending" } } },
  } as unknown as CodexSessionAdapter
  return { calls, queued, history, turns, enqueued, backend: nativeBackend(adapter) }
}
const item = (turnId = "turn-original"): ItemEntry => ({ turnId, item: { type: "userMessage", id: "actual-message", clientId: "input-original" } })

test("native input lookup follows all pages and the owning turn without using a cached queue receipt", async () => {
  const f = fixture()
  f.queued.set(undefined, { data: [{ id: "pending", clientUserMessageId: "input-original", input: [] }], nextCursor: null })
  expect(await f.backend.input!(ref, "input-original")).toEqual({ ref, inputID: "input-original", status: "queued", nativeID: "pending" })
  f.queued.clear()
  f.history.set(undefined, { data: [], nextCursor: "next" })
  f.history.set("next", { data: [item()], nextCursor: null })
  expect(await f.backend.input!(ref, "input-original")).toEqual({ ref, inputID: "input-original", status: "delivered", nativeID: "actual-message", turnID: "turn-original" })
  expect(await f.backend.input!(ref, "missing")).toEqual({ ref, inputID: "missing", status: "unknown" })
  expect(await f.backend.reconcile(ref, "input-original")).toEqual({ nativeID: "actual-message", kind: "message" })
  expect(f.calls.every((name) => ["ownership", "queue", "history", "turns"].includes(name))).toBe(true)
})

test("native input ambiguity and pagination cycles fail closed instead of selecting a task", async () => {
  const f = fixture()
  f.queued.set(undefined, { data: ["pending", "duplicate"].map((id) => ({ id, clientUserMessageId: "input-original", input: [] })), nextCursor: null })
  await expect(f.backend.input!(ref, "input-original")).rejects.toThrow("Ambiguous")
  f.queued.clear()
  f.history.set(undefined, { data: [item(), item("other-turn")], nextCursor: null })
  await expect(f.backend.input!(ref, "input-original")).rejects.toThrow("Ambiguous")
  f.history.clear()
  f.queued.set(undefined, { data: [], nextCursor: "loop" })
  f.queued.set("loop", { data: [], nextCursor: "loop" })
  await expect(f.backend.input!(ref, "input-original")).rejects.toThrow("Repeated")
})

test("native input lookup refuses another backend before reading a thread", async () => {
  const f = fixture()
  await expect(f.backend.input!({ ...ref, backendID: "foreign" }, "input-original")).rejects.toThrow("Different native backend")
  expect(f.calls).toEqual([])
})

test("terminal input proof comes from its exact turn across pages, never the latest turn or idle thread", async () => {
  const f = fixture()
  f.history.set(undefined, { data: [item()], nextCursor: null })
  f.turns.set(undefined, { data: [{ id: "new-active-turn", status: "inProgress" }], nextCursor: "older" })
  f.turns.set("older", { data: [{ id: "turn-original", status: "failed" }], nextCursor: null })
  expect(await f.backend.input!(ref, "input-original")).toEqual({ ref, inputID: "input-original", status: "closed", nativeID: "actual-message", turnID: "turn-original", state: "failed" })
  f.turns.set("older", { data: [], nextCursor: null })
  expect((await f.backend.input!(ref, "input-original")).status).toBe("unknown")
  f.turns.set("older", { data: [{ id: "turn-original", status: "completed" }, { id: "turn-original", status: "interrupted" }], nextCursor: null })
  await expect(f.backend.input!(ref, "input-original")).rejects.toThrow("Ambiguous")
  f.turns.set("older", { data: [], nextCursor: "older" })
  await expect(f.backend.input!(ref, "input-original")).rejects.toThrow("Repeated")
  expect(f.enqueued).toEqual([])
})

test("linked native admission revalidates parent identity and termination without replacing or steering work", async () => {
  const f = fixture()
  f.history.set(undefined, { data: [item()], nextCursor: null })
  const request = { ref, inputID: "child-input", text: "New linked task", followupOf: { inputID: "input-original", turnID: "turn-original", nativeID: "actual-message" } }
  expect(await f.backend.followup!(request)).toEqual({ status: "rejected", reason: "not-accepted" })
  f.turns.set(undefined, { data: [{ id: "turn-original", status: "completed" }], nextCursor: null })
  for (const parent of [{ ...request.followupOf, turnID: "wrong-turn" }, { ...request.followupOf, nativeID: "wrong-message" }])
    expect(await f.backend.followup!({ ...request, followupOf: parent })).toEqual({ status: "rejected", reason: "not-accepted" })
  expect(f.enqueued).toEqual([])
  expect(await f.backend.followup!(request)).toEqual({ kind: "queued", nativeID: "new-native-pending" })
  expect(f.enqueued).toEqual([[ref.threadID, "child-input", "New linked task"]])
})
