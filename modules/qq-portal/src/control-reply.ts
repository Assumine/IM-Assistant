import type { ControlResponse } from "./controls"
import type { Target } from "./target"

const label = (text: string, limit = 140) => Array.from(text.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, " ").replace(/\s+/g, " ").trim()).slice(0, limit).join("")
const target = (value: Target) => value.kind === "session" ? "会话 " + value.sessionID : value.ref.backendID + " / " + value.ref.threadID

/** Public control facts only. Do not invent idle/running, successful cancellation or a complete catalog. */
export function controlReply(response: ControlResponse): { text: string; viewID?: string } {
  const value = response.result, previous = response.duplicate ? "原命令" : ""
  const fixed = {
    forbidden: "该命令未获授权。", unsupported: "该命令尚未接入。", invalid: "命令参数无效，可发送 /codex 查看支持的格式。",
    unbound: "尚未绑定会话，可发送 /list 查看。", uncertain: "该命令的结果尚未确认；不会自动重试操作，请先核对。",
    conflict: "消息或目标发生冲突，未改用其他目标。", unchanged: previous + "没有确认撤回任何排队项。",
    "selection-required": "请引用已完整发布的对应清单，再指定序号。",
  }
  if (Object.hasOwn(fixed, value.kind)) return { text: fixed[value.kind as keyof typeof fixed] }
  if (value.kind === "help") return { text: "支持的命令：\n" + value.commands.join("\n") + "\n也支持 /codex 前缀及大小写形式。" }
  if (value.kind === "bound") return { text: previous + "已执行绑定：" + target(value.target) }
  if (value.kind === "unbound-applied") return { text: previous + "已执行解除绑定。" }
  if (value.kind === "withdraw-requested") return { text: previous + "已发出撤回请求：" + value.inputID + "\n只针对排队项；请以原生队列实际结果为准。" }
  if (value.kind === "unavailable") return { text: target(value.target) + " 当前无法读取，未转投其他会话。" }
  let text: string, viewID: string | undefined
  if (value.kind === "conversations") {
    text = "会话清单（本页 " + value.items.length + " 项）\n" + value.items.map((row) => row.index + ". " + (row.observed ? label(row.title) || target(row.target) : "本次未观察到") + " · " + target(row.target)).join("\n")
    if (!value.items.length) text += "暂无条目。"
    if (value.incomplete) text += "\n尚有其他分页，此处并非完整目录。"
    if (value.unavailable.length) text += "\n暂不可读的后端：" + value.unavailable.map((item) => label(item, 128)).join("、")
    if (value.items.length) text += "\n引用这条清单回复 /bind 序号 可选择目标。"
    viewID = value.viewID
  } else if (value.kind === "queue" || value.kind === "status") {
    text = target(value.target) + "\n" + (value.state ? "执行状态：" + label(value.state, 80) : "当前执行状态尚未确认。") + "\n待办（本页 " + value.items.length + " 项）\n"
    text += value.items.map((row, index) => (row.index ?? index + 1) + ". " + (row.observed === false ? "本次未观察到" : label(row.text) || row.inputID)).join("\n")
    if (!value.items.length) text += "本页没有待办项。"
    if (value.incomplete) text += "\n尚有其他分页，此处并非完整队列。"
    if (value.kind === "queue" && value.viewID) { if (value.items.length) text += "\n引用这条清单回复 /unqueue 序号 可请求撤回。"; viewID = value.viewID }
  } else throw new Error("Unsupported QQ control result")
  // A partial visual list must never publish selectors for addresses that were not actually shown.
  if (text.length > 16000) return { text: "清单过长，当前无法完整发送，未开放序号选择。请在客户端查看，或使用完整目标/输入 ID。" }
  return { text, ...(viewID ? { viewID } : {}) }
}
