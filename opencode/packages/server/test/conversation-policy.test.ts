import { expect, test } from "bun:test"
import { allows } from "../src/middleware/runtime-policy"

test("managed conversation backend RPC does not open generic plugin or file capabilities", () => {
  for (const action of [
    "list",
    "status",
    "threads",
    "history",
    "execution",
    "login",
    "cancelLogin",
    "create",
    "query",
    "control",
    "send",
    "reconcile",
    "input",
    "output",
  ]) {
    expect(allows("POST", `/api/rpc/experimental.conversation/${action}`)).toBe(true)
    expect(allows("GET", `/api/rpc/experimental.conversation/${action}`)).toBe(false)
  }
  for (const path of [
    "/api/rpc/experimental.conversation/exec",
    "/api/rpc/experimental.conversation/call",
    "/api/rpc/other/send",
    "/api/rpc/experimental.browser/open",
    "/api/experimental/terminal",
    "/api/file",
    "/api/mcp",
    "/api/session/id/shell",
  ])
    expect(allows("POST", path)).toBe(false)
  const amendment = "/api/session/ses_1/inbox/msg_1/append/msg_2"
  expect(allows("POST", amendment)).toBe(true)
  expect(allows("GET", amendment)).toBe(true)
  expect(allows("DELETE", amendment)).toBe(false)
  const continuation = "/api/session/ses_1/input/msg_1/continue/msg_2"
  expect(allows("POST", continuation)).toBe(true)
  expect(allows("GET", continuation)).toBe(true)
  expect(allows("DELETE", continuation)).toBe(false)
  expect(allows("POST", continuation + "/shell")).toBe(false)
  const followup = "/api/session/ses_1/input/msg_1/followup/msg_2"
  expect(allows("POST", followup)).toBe(true)
  expect(allows("GET", followup)).toBe(true)
  expect(allows("DELETE", followup)).toBe(false)
  expect(allows("GET", "/api/session/ses_1/input/msg_1")).toBe(true)
  expect(allows("POST", "/api/session/ses_1/input/msg_1")).toBe(false)
  const output = "/api/experimental/session/ses_1/input/msg_1/output"
  expect(allows("GET", output)).toBe(true)
  expect(allows("POST", output)).toBe(false)
  expect(allows("GET", output + "/shell")).toBe(false)
})

test("managed sessions expose API-owned JSON instruction entries with only their native methods", () => {
  const entries = "/api/experimental/session/ses_1/instructions/entries"
  expect(allows("GET", entries)).toBe(true)
  for (const method of ["POST", "PUT", "DELETE"]) expect(allows(method, entries)).toBe(false)
  expect(allows("PUT", entries + "/persona")).toBe(true)
  expect(allows("DELETE", entries + "/persona")).toBe(true)
  expect(allows("GET", entries + "/persona")).toBe(false)
  expect(allows("POST", entries + "/persona")).toBe(false)
})

test("JSON instruction access does not open ambient discovery, paths or generic file operations", () => {
  for (const pathname of ["/api/instructions", "/api/session/ses_1/instructions",
    "/api/experimental/session/ses_1/instructions/entries/persona/file", "/api/file", "/api/fs/read", "/api/session/ses_1/shell"])
    for (const method of ["GET", "POST", "PUT", "DELETE"]) expect(allows(method, pathname)).toBe(false)
})
