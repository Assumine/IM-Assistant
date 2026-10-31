import { expect, test } from "bun:test"
import { createPortal } from "../src"

test("another whitelisted member cannot recall a group peer's existing input", async () => {
  let writes = 0
  let nativeReads = 0
  const unused = async () => { nativeReads++; throw new Error("Native API must not be reached") }
  const portal = createPortal({
    policy: { botID: "10001", allowedUsers: ["20001", "20002"], allowedGroups: ["30001"] },
    storage: {
      get: async () => ({ sessionID: "ses_existing", inputID: "msg_existing", actorID: "20001", fingerprint: "existing" }),
      set: async () => { writes++ },
      insert: async () => { writes++; return true },
    },
    session: { get: unused, prompt: unused, message: { get: unused }, inbox: { list: unused, cancel: unused, update: unused } },
  })
  expect(await portal.receive({ post_type: "notice", notice_type: "group_recall", self_id: "10001", group_id: "30001", user_id: "20002", message_id: "same-group-message" })).toEqual({ status: "unchanged" })
  expect(writes).toBe(0)
  expect(nativeReads).toBe(0)
})
