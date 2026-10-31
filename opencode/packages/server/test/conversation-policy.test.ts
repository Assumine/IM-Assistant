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
})
