export { fakeOneBot, until } from "../../../qq-protocol/test/fixture/onebot"
export type { Call } from "../../../qq-protocol/test/fixture/onebot"
export const policy = { botID: "10001", allowedUsers: ["20001", "20002"], allowedGroups: ["30001"] }
export const event = (id: number, text: string, actor = "20001") => ({
  post_type: "message", self_id: "10001", message_type: "private", user_id: actor, message_id: id,
  message: [{ type: "text", data: { text } }],
})
