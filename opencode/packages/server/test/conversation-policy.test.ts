import { expect, test } from "bun:test"
import { allows } from "../src/middleware/runtime-policy"

test("managed conversation backend RPC does not open generic plugin or file capabilities", () => {
  for (const action of [
    "list",
    "status",
    "threads",
    "history",
    "login",
    "cancelLogin",
    "create",
    "query",
    "control",
    "send",
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
})
