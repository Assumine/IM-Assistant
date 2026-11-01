import { expect, test } from "bun:test"
import { openQQChannel, type ChannelIssue, type Result } from "../src"
import { event, fakeOneBot, policy, until } from "./fixture/onebot"

const accepted = (id: number): Result => ({ status: "accepted", target: { kind: "session", sessionID: "ses_fixture" }, inputID: "msg_" + id, duplicate: false })
const connection = (fake: ReturnType<typeof fakeOneBot>) => ({ url: fake.url, token: fake.token })

test("one scope preserves bind/admission arrival order while unrelated scopes proceed without waiting for AI completion", async () => {
  const fake = fakeOneBot(), release = Promise.withResolvers<void>(), calls: { id: number; binding: string }[] = []
  let binding = "old"
  const channel = openQQChannel({ policy, connection: connection(fake), onResult() {}, portal: { receive: async (raw) => {
    const input = raw as ReturnType<typeof event>
    calls.push({ id: input.message_id, binding })
    if (input.message_id === 1) { await release.promise; binding = "new" }
    return accepted(input.message_id)
  } } })
  try {
    await channel.ready
    fake.event(event(1, "/bind new")); fake.event(event(2, "Next same scope")); fake.event(event(3, "Other scope", "20002"))
    await until(() => calls.length === 2)
    expect(calls.map((value) => value.id)).toEqual([1, 3])
    release.resolve(); await until(() => calls.length === 3)
    expect(calls[2]).toEqual({ id: 2, binding: "new" })
  } finally { release.resolve(); await channel.close(); fake.close() }
})

test("unknown admission stops only its own scope and reports unforwarded messages instead of guessing a binding", async () => {
  const fake = fakeOneBot(), calls: number[] = [], issues: ChannelIssue[] = []
  const channel = openQQChannel({ policy, connection: connection(fake), onResult() {}, onIssue: (value) => issues.push(value),
    portal: { receive: async (raw) => { const id = (raw as ReturnType<typeof event>).message_id; calls.push(id); return id === 1 ? { status: "uncertain" } : accepted(id) } } })
  try {
    await channel.ready
    fake.event(event(1, "Unknown")); fake.event(event(2, "Must not forward")); fake.event(event(3, "Other scope", "20002"))
    await until(() => issues.some((value) => value.kind === "not-forwarded") && calls.includes(3))
    expect(calls).toEqual([1, 3]); expect(channel.state().blockedScopes).toBe(1)
    expect(JSON.stringify(issues)).not.toContain("Must not forward")
  } finally { await channel.close(); fake.close() }
})

test("input and notification errors are reported separately and never cause another native admission", async () => {
  const fake = fakeOneBot(), calls: number[] = [], issues: ChannelIssue[] = []
  const channel = openQQChannel({ policy, connection: connection(fake),
    onResult() { throw new Error("Output callback failed") }, onIssue: (value) => issues.push(value),
    portal: { receive: async (raw) => { const id = (raw as ReturnType<typeof event>).message_id; calls.push(id); if (id === 1) throw new Error("Admission error"); return accepted(id) } } })
  try {
    await channel.ready
    fake.event(event(1, "Error")); fake.event(event(2, "Known", "20002")); fake.event(event(3, "Next", "20002"))
    await until(() => issues.filter((value) => value.kind === "callback-error").length === 2)
    expect(calls).toEqual([1, 2, 3]); expect(issues.some((value) => value.kind === "handler-error")).toBe(true)
  } finally { await channel.close(); fake.close() }
})

test("close drops unstarted ingress and waits for begun admission only, never interrupting native model execution", async () => {
  const fake = fakeOneBot(), release = Promise.withResolvers<void>(), calls: number[] = [], issues: ChannelIssue[] = []
  let closed = false
  const channel = openQQChannel({ policy, connection: connection(fake), onResult() {}, onIssue: (value) => issues.push(value),
    portal: { receive: async (raw) => { calls.push((raw as ReturnType<typeof event>).message_id); await release.promise; return accepted(1) } } })
  try {
    await channel.ready; fake.event(event(1, "Begun")); fake.event(event(2, "Not begun"))
    await until(() => channel.state().pendingEvents === 2)
    const closing = channel.close().then(() => { closed = true })
    await Bun.sleep(10); expect(closed).toBe(false)
    release.resolve(); await closing
    expect(calls).toEqual([1]); expect(channel.state()).toMatchObject({ phase: "closed", pendingEvents: 0, activeAdmissions: 0 })
    expect(issues.some((value) => value.kind === "not-forwarded")).toBe(true)
  } finally { release.resolve(); await channel.close(); fake.close() }
})

test("bounded ingress overload closes this channel without accumulating a durable task queue", async () => {
  const fake = fakeOneBot(), release = Promise.withResolvers<void>(), calls: number[] = [], issues: ChannelIssue[] = []
  const channel = openQQChannel({ policy, connection: connection(fake), maxPendingEvents: 1, onResult() {}, onIssue: (value) => issues.push(value),
    portal: { receive: async (raw) => { calls.push((raw as ReturnType<typeof event>).message_id); await release.promise; return accepted(1) } } })
  try {
    await channel.ready; fake.event(event(1, "Begun")); await until(() => calls.length === 1)
    fake.event(event(2, "Overload")); await until(() => issues.some((value) => value.kind === "overloaded"))
    release.resolve(); await channel.close()
    expect(calls).toEqual([1]); expect(channel.state().pendingEvents).toBe(0)
  } finally { release.resolve(); await channel.close(); fake.close() }
})
