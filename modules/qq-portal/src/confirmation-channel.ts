import { createHash } from "node:crypto"
import type { StorageDomain } from "../../../opencode/packages/plugin/src/promise/storage"
import type { createPortal, Result } from "./index"
import { confirmations, type Proposal } from "./confirmation"
import { claimIngress } from "./controls"
import { delivery } from "./delivery"
import { command, decode, fingerprint, inputID, originKey, type Message, type Policy } from "./routing"
import type { Source } from "./sources"
import { sameTarget, type Target } from "./target"
import type { SendResult } from "./onebot"
import type { NotificationReceipt } from "./notifications"
import type { HistoricalInput } from "./history"

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const label = (value: string) => Array.from(value.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, " ").replace(/\s+/g, " ").trim()).slice(0, 100).join("")

/** QQ consent interaction only. The original portal and native backend still own routing and admission. */
export function createConfirmationChannel(options: {
  storage: Pick<StorageDomain, "get" | "set" | "insert">; policy: Policy
  portal: Pick<ReturnType<typeof createPortal>, "receive" | "confirm" | "recalled">
  send: (source: Source, text: string) => Promise<SendResult | { status: "forbidden" }>
  read: (source: Source) => Promise<unknown | undefined>
  describe?: (target: Target) => Promise<string | undefined>
  onReceipt?: (receipt: NotificationReceipt) => void
}) {
  const consent = confirmations(options.storage), receipts = delivery(options)
  const report = (value: NotificationReceipt) => { try { options.onReceipt?.(value) } catch { /* Observer only. */ } }
  const notice = async (input: Message, identity: string, body: () => Promise<string>, publish?: (id: string) => Promise<void>, reconcileOnly = false) => {
    try {
      const source: Source = { scope: input.scope, actorID: input.actorID, messageID: input.messageID }
      const key = "notification:consent:" + originKey(input.scope, input.messageID), receiptKey = "notification-receipt:consent:" + originKey(input.scope, input.messageID)
      const finish = async (value: unknown) => {
        if (!record(value) || value.version !== 1 || value.identity !== identity || value.fingerprint !== fingerprint(input) ||
          JSON.stringify(value.source) !== JSON.stringify(source) || typeof value.bodyHash !== "string" || !/^[a-f0-9]{64}$/.test(value.bodyHash) ||
          value.hash !== hash({ version: 1, source, fingerprint: fingerprint(input), identity, bodyHash: value.bodyHash })) return { status: "conflict" as const }
        return receipts.finish(receiptKey, value.hash as string, true, publish)
      }
      const old = await options.storage.get(key)
      if (old !== undefined) { report(await finish(old)); return }
      if (reconcileOnly) { report({ status: "uncertain" }); return }
      if (await options.storage.get(receiptKey) !== undefined) { report({ status: "uncertain" }); return }
      const text = await body(), content = { version: 1, source, fingerprint: fingerprint(input), identity, bodyHash: hash(text) }
      const intent = { ...content, hash: hash(content) }
      if (!await options.storage.insert(key, intent)) { report(await finish(await options.storage.get(key))); return }
      report(await receipts.attempt(receiptKey, intent.hash, source, text, publish))
    } catch { report({ status: "uncertain" }) }
  }
  const prompt = async (input: Message, response: Extract<Result, { status: "confirmation-required" }>) => {
    const proposal = await consent.read(input)
    if (!proposal || proposal.id !== response.confirmationID || !sameTarget(proposal.to, response.target)) throw new Error("Unproven confirmation request")
    await notice(input, proposal.id, async () => {
      const name = await options.describe?.(proposal.to).catch(() => undefined)
      const fallback = proposal.to.kind === "session" ? proposal.to.sessionID : proposal.to.ref.backendID + " / " + proposal.to.ref.threadID
      return "这条引用属于另一个会话：" + (name ? label(name) : fallback) + "\n引用本提示回复 /confirm 确认，或 /cancel 取消。当前绑定保持不变。"
    }, (id) => consent.publish(input, id))
  }
  return {
    async receive(raw: unknown, recovery?: HistoricalInput): Promise<Result> {
      const event = decode(raw, options.policy)
      if (event.kind !== "message") return options.portal.receive(raw, recovery)
      const input = event.message, action = command(input.text)
      if (action?.action !== "confirm" && action?.action !== "cancel") {
        const result = await options.portal.receive(raw, recovery)
        if (result.status === "confirmation-required") await prompt(input, result)
        return result
      }
      let proposal: Proposal | undefined
      let result: Extract<Result, { status: "confirmation-control" }>["result"]
      try {
        if (await options.portal.recalled(input)) return { status: "recalled" }
        const ingress = await claimIngress(options.storage, input, true)
        if (ingress === "conflict") return { status: "conflict" }
        if (ingress === "duplicate") {
          // A refused or interrupted command cannot become executable on redelivery after later publication or a recovered read.
          await notice(input, action.action, async () => "", undefined, true)
          return { status: "confirmation-control", commandID: inputID(input), result: { status: "confirmation-previous" } }
        }
        proposal = !action.arguments.trim() && input.quoteID ? await consent.prompt(input.scope, input.quoteID, input.actorID) : undefined
        if (!proposal) result = { status: "confirmation-selection-required" }
        else {
          const choice = action.action === "confirm" ? "approve" : "decline", previous = await consent.choice(proposal)
          if (previous && previous !== choice) result = { status: "confirmation-already-decided", choice: previous }
          else {
            const original = await options.read(proposal.source)
            result = original === undefined ? { status: "confirmation-unavailable" } : await options.portal.confirm(original, {
              confirmationID: proposal.id, scope: input.scope, actorID: input.actorID, choice,
            })
          }
        }
      } catch { result = { status: "uncertain" } }
      const response: Extract<Result, { status: "confirmation-control" }> = { status: "confirmation-control", commandID: inputID(input), result }
      await notice(input, action.action, async () => reply(result))
      return response
    },
  }
}

function reply(result: Extract<Result, { status: "confirmation-control" }>["result"]) {
  switch (result.status) {
    case "accepted": case "followup": return "已确认，原消息已交给对应会话。当前绑定保持不变。"
    case "amended": return "已确认，补充已追加到原排队任务。当前绑定保持不变。"
    case "steered": return "已确认，调整已交给原任务，等待原生执行器处理。当前绑定保持不变。"
    case "confirmation-declined": return "已取消本次跨会话发送。"
    case "confirmation-selection-required": return "请引用对应的确认提示，再回复 /confirm 或 /cancel。"
    case "confirmation-unavailable": return "无法读取原消息，尚未确认或发送。请重新发送原需求。"
    case "confirmation-previous": return "这条确认指令已接收过，本次不会重复执行；请核对原任务。"
    case "confirmation-already-decided": return result.choice === "approve" ? "此前已确认，本次取消不会撤回已交付的任务。" : "此前已取消，请重新发送需求以发起新的确认。"
    case "recalled": return "原消息已撤回，不再发送。"
    case "blocked": return "原任务状态已变化，本次调整未交付；请查看原任务后重新发送。"
    case "uncertain": return "确认结果尚未核实，不会自动重试任务；请先核对。"
    default: return "本次确认未通过核对，没有改投其他会话。"
  }
}
