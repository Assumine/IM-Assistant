import { expect, test } from "bun:test"
import { openOneBot } from "../src/index"
const portalTransport = await import("../../qq-portal/src/onebot")
import { fakeOneBot, until } from "./fixture/onebot"

const scope = (botID: string) => ({ botID, kind: "group" as const, peerID: "30001" })
const event = (botID: string, text: string) => ({
  self_id: botID, post_type: "message", message_type: "group", group_id: "30001",
  user_id: "20001", message_id: 1, message: [{ type: "text", data: { text } }],
})

test("the portal compatibility entry uses the same public transport and account lease", () => {
  expect(portalTransport.openOneBot).toBe(openOneBot)
})

test("independent consumers retain their own credentials, same-group events and replies", async () => {
  const portal = fakeOneBot({ botID: "10001", token: "portal-fixture" })
  const chatbot = fakeOneBot({ botID: "10002", token: "chat-fixture" })
  const tasks: unknown[] = [], chats: unknown[] = []
  const first = portalTransport.openOneBot({ url: portal.url, token: portal.token, botID: "10001" }, { event: (value) => tasks.push(value) })
  const second = openOneBot({ url: chatbot.url, token: chatbot.token, botID: "10002" }, { event: (value) => chats.push(value) })
  try {
    expect((await first.ready).phase).toBe("online")
    expect((await second.ready).phase).toBe("online")
    portal.event(event("10001", "Task")); chatbot.event(event("10002", "Chat"))
    await until(() => tasks.length === 1 && chats.length === 1)
    expect(tasks).toEqual([event("10001", "Task")]); expect(chats).toEqual([event("10002", "Chat")])
    expect((await first.send(scope("10001"), "Task reply", "1")).status).toBe("sent")
    expect((await second.send(scope("10002"), "Chat reply", "1")).status).toBe("sent")
    expect(portal.upgrades[0]?.header).toBe("Bearer portal-fixture")
    expect(chatbot.upgrades[0]?.header).toBe("Bearer chat-fixture")
    expect(JSON.stringify(portal.calls)).not.toContain("Chat reply")
    expect(JSON.stringify(chatbot.calls)).not.toContain("Task reply")
    expect(await second.send(scope("10001"), "Wrong account", "1")).toEqual({ status: "unavailable" })
    expect(chatbot.calls.filter((call) => call.action.startsWith("send_"))).toHaveLength(1)
  } finally { first.close(); second.close(); portal.close(); chatbot.close() }
})

for (const mode of ["stop", "disconnect", "malformed", "identity"] as const) test("one consumer remains usable after its neighbor: " + mode, async () => {
  const portal = fakeOneBot({ botID: "10001" }), chatbot = fakeOneBot({ botID: "10002" }), seen: unknown[] = []
  const first = portalTransport.openOneBot({ url: portal.url, token: portal.token, botID: "10001" }, { event() {} })
  const second = openOneBot({ url: chatbot.url, token: chatbot.token, botID: "10002" }, { event: (value) => seen.push(value) })
  try {
    await Promise.all([first.ready, second.ready])
    if (mode === "stop") first.close()
    if (mode === "disconnect") portal.close()
    if (mode === "malformed") portal.frame("<!DOCTYPE html>")
    if (mode === "identity") portal.event(event("10002", "Foreign account"))
    await until(() => ["closed", "unavailable"].includes(first.state().phase))
    expect(second.state().phase).toBe("online")
    chatbot.event(event("10002", "Still online")); await until(() => seen.length === 1)
    expect((await second.send(scope("10002"), "Still sends", "1")).status).toBe("sent")
    expect(chatbot.upgrades).toHaveLength(1)
    expect(chatbot.calls.filter((call) => call.action === "get_status")).toHaveLength(1)
  } finally { first.close(); second.close(); portal.close(); chatbot.close() }
})

test("two consumers cannot open the same account; closing the rejected one cannot release the owner", async () => {
  const portal = fakeOneBot(), chatbot = fakeOneBot()
  const first = portalTransport.openOneBot({ url: portal.url, token: portal.token, botID: "10001" }, { event() {} })
  const second = openOneBot({ url: chatbot.url, token: chatbot.token, botID: "10001" }, { event() {} })
  try {
    expect((await first.ready).phase).toBe("online")
    expect(await second.ready).toEqual({ phase: "unavailable", reason: "account-in-use" })
    expect(chatbot.upgrades).toHaveLength(0)
    second.close()
    const third = openOneBot({ url: chatbot.url, token: chatbot.token, botID: "10001" }, { event() {} })
    try { expect(await third.ready).toEqual({ phase: "unavailable", reason: "account-in-use" }) }
    finally { third.close() }
    expect((await first.send(scope("10001"), "Original owner", "1")).status).toBe("sent")
    first.close()
    const replacement = openOneBot({ url: chatbot.url, token: chatbot.token, botID: "10001" }, { event() {} })
    try { expect((await replacement.ready).phase).toBe("online") }
    finally { replacement.close() }
  } finally { first.close(); second.close(); portal.close(); chatbot.close() }
})

test("verification failure releases only its own account reservation", async () => {
  const failed = fakeOneBot({ botID: "10003" }), valid = fakeOneBot()
  const first = openOneBot({ url: failed.url, token: failed.token, botID: "10001" }, { event() {} })
  try {
    expect(await first.ready).toEqual({ phase: "unavailable", reason: "identity" })
    const second = openOneBot({ url: valid.url, token: valid.token, botID: "10001" }, { event() {} })
    try {
      expect((await second.ready).phase).toBe("online")
      first.close()
      const third = openOneBot({ url: valid.url, token: valid.token, botID: "10001" }, { event() {} })
      try { expect((await third.ready).reason).toBe("account-in-use") }
      finally { third.close() }
      expect((await second.send(scope("10001"), "Retained owner", "1")).status).toBe("sent")
    } finally { second.close() }
  } finally { first.close(); failed.close(); valid.close() }
})

test("closing one consumer settles its in-flight send as unknown without replay or stopping the other", async () => {
  const portal = fakeOneBot({ call: (_socket, call) => call.action.startsWith("send_") || undefined })
  const chatbot = fakeOneBot({ botID: "10002" })
  const first = portalTransport.openOneBot({ url: portal.url, token: portal.token, botID: "10001" }, { event() {} })
  const second = openOneBot({ url: chatbot.url, token: chatbot.token, botID: "10002" }, { event() {} })
  try {
    await Promise.all([first.ready, second.ready])
    const pending = first.send(scope("10001"), "Unknown receipt", "1")
    await until(() => portal.calls.some((call) => call.action.startsWith("send_")))
    first.close()
    expect(await pending).toEqual({ status: "uncertain" })
    expect(portal.calls.filter((call) => call.action.startsWith("send_"))).toHaveLength(1)
    expect((await second.send(scope("10002"), "Unaffected", "1")).status).toBe("sent")
  } finally { first.close(); second.close(); portal.close(); chatbot.close() }
})
