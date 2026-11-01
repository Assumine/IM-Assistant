import { expect, test } from "bun:test"
import { createHistory, historyConfiguration, historicalInput, historicalText } from "../src/history"
import { policy } from "./fixture/onebot"
import { historyEvent, historyStorage } from "./fixture/history"

const scope = { botID: "10001", kind: "private" as const, peerID: "20001" }
const config = { provider: "napcat" as const, pageSize: 2, maxPages: 4 }

test("history requires an explicit provider and bounded settings while preserving disabled legacy configuration", () => {
  expect(historyConfiguration(undefined)).toBeUndefined()
  expect(historyConfiguration({ provider: "napcat" })).toEqual({ provider: "napcat", pageSize: 100, maxPages: 10 })
  for (const value of [{ provider: "onebot" }, { provider: "napcat", pageSize: 1 }, { provider: "napcat", pageSize: 101 },
    { provider: "napcat", maxPages: 21 }, { provider: "napcat", pageSize: 100, maxPages: 11 }, { provider: "napcat", token: "no" }])
    expect(() => historyConfiguration(value)).toThrow()
})

test("history uses real per-peer sequence values beyond number precision and opaque message-ID page anchors", async () => {
  const f = historyStorage(), calls: (string | undefined)[] = []
  const rows = [historyEvent(-900, "90071992547409930"), historyEvent(5, "90071992547409931"), historyEvent(-20, "90071992547409932")]
  const history = createHistory({ storage: f.storage, policy, config,
    read: async (_, before) => { calls.push(before); return before === undefined ? [rows[2], rows[1]] : [rows[1], rows[0]] },
  })
  await history.commit(history.entry(rows[0])!)
  expect((await history.collect(scope)).map((row) => row.messageID)).toEqual(["5", "-20"])
  expect(calls).toEqual([undefined, "5"])
  expect(JSON.stringify([...f.values.values()])).not.toContain("Body")
})

test("missing boundaries and repeating pages fail without pretending the newest page is a complete recovery", async () => {
  for (const data of [[historyEvent(3, "103"), historyEvent(4, "104")], []]) {
    const f = historyStorage(), calls: unknown[] = []
    const history = createHistory({ storage: f.storage, policy, config,
      read: async (_, before) => { calls.push(before); return data },
    })
    await history.commit(history.entry(historyEvent(1, "100"))!)
    await expect(history.collect(scope)).rejects.toThrow()
    expect(calls.length).toBeLessThanOrEqual(2)
    expect(f.values.get("history:cursor:10001:private:20001")).toMatchObject({ messageID: "1", sequence: "100" })
  }
})

test("mixed peers, conflicting sequences and pages that cross their anchor cannot be replayed", async () => {
  const variants = [
    [historyEvent(2, "101"), historyEvent(3, "101")],
    [historyEvent(2, "101"), historyEvent(3, "102", "Wrong peer", "20002")],
    [historyEvent(2, "101"), { ...historyEvent(3, "102"), real_seq: undefined }],
  ]
  for (const rows of variants) {
    const f = historyStorage(), history = createHistory({ storage: f.storage, policy, config, read: async () => rows })
    await history.commit(history.entry(historyEvent(1, "100"))!)
    await expect(history.collect(scope)).rejects.toThrow()
  }
  const f = historyStorage(), history = createHistory({ storage: f.storage, policy, config,
    read: async (_, before) => before === undefined ? [historyEvent(3, "102"), historyEvent(4, "103")] : [historyEvent(1, "100"), historyEvent(5, "104")],
  })
  await history.commit(history.entry(historyEvent(1, "100"))!)
  await expect(history.collect(scope)).rejects.toThrow("anchor")
})

test("history cursor discovery obeys current peer permissions and never infers another bot or group", async () => {
  const f = historyStorage(), history = createHistory({ storage: f.storage, policy, config, read: async () => [] })
  await history.commit(history.entry(historyEvent(1, "100"))!)
  await history.commit(history.entry(historyEvent(2, "101", "Group", "20001", "30001"))!)
  expect(await history.scopes()).toHaveLength(2)
  const restricted = createHistory({ storage: f.storage, policy: { ...policy, allowedGroups: [] }, config, read: async () => { throw new Error("Must not read revoked scope") } })
  expect(await restricted.scopes()).toEqual([scope])
  expect(history.entry({ ...historyEvent(3, "102"), self_id: "10002" })).toBeUndefined()
  expect(history.entry(historyEvent(3, "102", "Foreign group", "20001", "30002"))).toBeUndefined()
  expect(history.entry({ ...historyEvent(3, "102", "Outgoing", "10001"), target_id: "20002" }, scope)).toBeUndefined()
  expect(history.entry({ ...historyEvent(3, "102"), post_type: "message_sent" })!.raw.post_type).toBe("message_sent")
})

test("late observations cannot move a cursor backwards or replace its same-sequence identity", async () => {
  const f = historyStorage(), history = createHistory({ storage: f.storage, policy, config, read: async () => [] })
  await history.commit(history.entry(historyEvent(2, "101"))!)
  await history.commit(history.entry(historyEvent(1, "100"))!)
  expect(f.values.get("history:cursor:10001:private:20001")).toMatchObject({ sequence: "101", messageID: "2" })
  await expect(history.commit(history.entry(historyEvent(3, "101"))!)).rejects.toThrow("boundary")
  await history.commit(history.entry(historyEvent(4, "104"))!)
  expect(f.values.get("history:cursor:10001:private:20001")).toMatchObject({ sequence: "101" })
  await history.commit(history.entry(historyEvent(4, "104"))!, true)
  expect(f.values.get("history:cursor:10001:private:20001")).toMatchObject({ sequence: "104" })
})

test("historical delivery preserves the original date without changing ordinary input or accepting invented context", () => {
  const context = { sentAt: 1700000000000, recoveredAt: 1700086400000 }
  expect(historicalInput(context)).toEqual(context)
  expect(historicalText("明天提醒我", context)).toContain("2023-11-14T22:13:20.000Z")
  expect(historicalText("明天提醒我", context)).toEndWith("\n明天提醒我")
  expect(historicalText("Ordinary input")).toBe("Ordinary input")
  expect(() => historicalInput({ ...context, text: "Invented body" })).toThrow()
  expect(() => historicalInput({ ...context, sentAt: NaN })).toThrow()
})
