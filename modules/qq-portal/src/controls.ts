import type { StorageDomain } from "../../../opencode/packages/plugin/src/promise/storage"
import { fingerprint, inputID, originKey, type Message, type Policy, type Scope } from "./routing"
import { sameTarget, target, targets, type Native, type Backend, type Target, type Withdrawal } from "./target"
import type { Origin } from "./sources"
import { views, isViewID } from "./views"

type Storage = Pick<StorageDomain, "get" | "set" | "insert">
export type ControlOptions = { allowedUsers: readonly string[]; backendIDs?: readonly string[] }
type Row = { inputID: string; nativeID: string; text: string; index?: number; observed?: boolean }
export type ControlResult =
  | { kind: "forbidden" | "unsupported" | "invalid" | "unbound" | "uncertain" | "conflict" | "unchanged" | "selection-required" }
  | { kind: "help"; commands: string[] }
  | { kind: "bound"; target: Target }
  | { kind: "unbound-applied" }
  | { kind: "withdraw-requested"; target: Target; inputID: string }
  | { kind: "unavailable"; target: Target }
  | { kind: "conversations"; viewID: string; items: { target: Target; title: string; index: number; observed: boolean }[]; incomplete: boolean; unavailable: string[] }
  | { kind: "queue" | "status"; target: Target; viewID?: string; items: Row[]; incomplete: boolean; state?: string }
export type ControlResponse = { status: "control"; action: string; commandID: string; duplicate: boolean; result: ControlResult }
type Plan = { fingerprint: string; action: "bind" | "unbind" | "unqueue"; target?: Target; inputID?: string; nativeID?: string; viewID?: string }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)

/** Shared immutable envelope classification, not an execution/admission queue. Conflicting redelivery cannot change lanes. */
export async function claimIngress(storage: Storage, input: Message, control: boolean): Promise<"new" | "duplicate" | "conflict"> {
  const key = "ingress:" + originKey(input.scope, input.messageID)
  const value = { fingerprint: fingerprint(input), kind: control ? "control" : "input" }
  if (await storage.insert(key, value)) return "new"
  const found = await storage.get(key)
  return record(found) && found.fingerprint === value.fingerprint && found.kind === value.kind ? "duplicate" : "conflict"
}

/** Host-authorized commands use only public application APIs. No model calls, replay loop, timer or task scheduler. */
export function controls(options: {
  storage: Storage; policy: Policy; permissions: ControlOptions; session: Native; backend?: Backend
  binding: (scope: Scope) => Promise<Target | undefined>
  bind: (scope: Scope, value?: Target) => Promise<void>
  lookup: (scope: Scope, messageID: string) => Promise<Origin | undefined>
  onWithdrawal?: (value: Withdrawal) => Promise<void>
}) {
  const { storage, session, backend, permissions } = options
  const native = targets(session, backend, options.onWithdrawal)
  const allowedTarget = (value: Target) => value.kind === "session" || !!permissions.backendIDs?.includes(value.ref.backendID)
  const selection = views({ storage, policy: options.policy, canPublish: (source) => permissions.allowedUsers.includes(source.actorID), allowedTarget })
  const parse = (value: unknown): Plan => {
    if (!record(value) || !digest(value.fingerprint) || !["bind", "unbind", "unqueue"].includes(String(value.action)) ||
      Object.keys(value).some((key) => !["fingerprint", "action", "target", "inputID", "nativeID", "viewID"].includes(key))) throw new Error("Invalid control intent")
    const destination = value.target === undefined ? undefined : target(value.target)
    if (value.action === "unbind" ? destination !== undefined || value.inputID !== undefined : !destination ||
      (value.action === "unqueue" ? !id(value.inputID) : value.inputID !== undefined)) throw new Error("Invalid control target")
    if (value.viewID !== undefined && (!isViewID(value.viewID) || value.action === "unbind") ||
      value.nativeID !== undefined && (value.action !== "unqueue" || !isViewID(value.viewID) || !id(value.nativeID)) ||
      value.action === "unqueue" && value.viewID !== undefined && !id(value.nativeID) ||
      destination?.kind === "session" && value.nativeID !== undefined && value.nativeID !== value.inputID) throw new Error("Invalid frozen selection")
    return value as Plan
  }
  const queue = async (destination: Target): Promise<{ items: Row[]; incomplete: boolean; state?: string }> => {
    if (!allowedTarget(destination)) throw new Error("Backend is not authorized")
    if (destination.kind === "session") {
      await native.validate(destination)
      const items = await session.inbox.list({ sessionID: destination.sessionID })
      if (items.some((item) => item.sessionID !== destination.sessionID)) throw new Error("Wrong Session inbox")
      return { items: items.flatMap((item) => item.type === "user" ? [{ inputID: item.id, nativeID: item.id, text: item.payload.text }] : []), incomplete: false }
    }
    if (!backend) throw new Error("Backend unavailable")
    const snapshot = await backend.execution({ ref: destination.ref, limit: 100 })
    if (!sameTarget(destination, { kind: "backend", ref: snapshot.thread.ref })) throw new Error("Wrong backend execution")
    if (new Set(snapshot.queue.map((item) => item.inputID)).size !== snapshot.queue.length) throw new Error("Ambiguous native queue")
    return { items: snapshot.queue.map((item) => ({ inputID: item.inputID, nativeID: item.nativeID, text: item.text })), incomplete: !!snapshot.nextCursor, state: snapshot.thread.state }
  }
  const readReceipt = async (key: string, plan: Plan): Promise<ControlResult> => {
    const value = await storage.get(key)
    if (!record(value)) return { kind: "uncertain" }
    if (plan.action === "bind" && value.kind === "bound" && plan.target && sameTarget(target(value.target), plan.target)) return { kind: "bound", target: plan.target }
    if (plan.action === "unbind" && value.kind === "unbound-applied") return { kind: "unbound-applied" }
    if (plan.action === "unqueue" && plan.target && value.kind === "withdraw-requested" && value.inputID === plan.inputID && sameTarget(target(value.target), plan.target))
      return { kind: "withdraw-requested", target: plan.target, inputID: plan.inputID! }
    if (plan.action === "unqueue" && value.kind === "unchanged") return { kind: "unchanged" }
    return { kind: "uncertain" }
  }
  const receive = async (input: Message, command: { action: string; arguments: string }, duplicate: boolean): Promise<ControlResponse> => {
    const respond = (result: ControlResult): ControlResponse => ({ status: "control", commandID: inputID(input), action: command.action, duplicate, result })
    // Task permission alone never grants remote control. Check before reading bindings, native state or control receipts.
    if (input.scope.botID !== options.policy.botID || !permissions.allowedUsers.includes(input.actorID)) return respond({ kind: "forbidden" })
    const args = command.arguments.trim()
    try {
      if (command.action === "help" && !args) return respond({ kind: "help", commands: ["/list", "/bind session <id>", "/bind backend <backendID> <threadID>", "/unbind", "/queue", "/unqueue <inputID>", "/status"] })
      if (command.action === "list" && !args) {
        if (!session.list) return respond({ kind: "unsupported" })
        const page = await session.list({ limit: 100, order: "desc", archived: false })
        const items = page.data.map((item) => ({ target: target(item.id), title: item.title ?? item.id }))
        let incomplete = !!page.cursor.next
        const unavailable: string[] = []
        for (const backendID of new Set(permissions.backendIDs ?? [])) {
          try {
            if (!backend?.threads) throw new Error("Backend browsing unavailable")
            const page = await backend.threads({ backendID, limit: 100 })
            const found = page.items.map((item) => {
              const destination = target({ kind: "backend", ref: item.ref })
              if (destination.kind !== "backend" || destination.ref.backendID !== backendID) throw new Error("Wrong backend list")
              return { target: destination, title: item.title }
            })
            items.push(...found)
            incomplete ||= !!page.nextCursor
          } catch { unavailable.push(backendID) }
        }
        const view = await selection.prepare(input, { kind: "conversations", items: items.map((item) => item.target), incomplete })
        if (view.kind !== "conversations") throw new Error("Wrong catalog view")
        if (!view.items.every(allowedTarget)) return respond({ kind: "forbidden" })
        return respond({ kind: "conversations", viewID: view.id, items: view.items.map((destination, index) => {
          const found = items.find((item) => sameTarget(item.target, destination))
          return { target: destination, title: found?.title ?? "", index: index + 1, observed: !!found }
        }), incomplete: view.incomplete, unavailable })
      }
      if ((command.action === "queue" || command.action === "status") && !args) {
        const destination = await options.binding(input.scope)
        if (!destination) return respond({ kind: "unbound" })
        if (!allowedTarget(destination)) return respond({ kind: "forbidden" })
        try {
          const live = await queue(destination)
          if (command.action === "status") return respond({ kind: "status", target: destination, ...live })
          const view = await selection.prepare(input, { kind: "queue", target: destination,
            items: live.items.map(({ inputID, nativeID }) => ({ inputID, nativeID })), incomplete: live.incomplete })
          if (view.kind !== "queue") throw new Error("Wrong queue view")
          if (!allowedTarget(view.target)) return respond({ kind: "forbidden" })
          const items = view.items.map((address, index) => {
            const found = sameTarget(view.target, destination) ? live.items.find((item) => item.inputID === address.inputID && item.nativeID === address.nativeID) : undefined
            return { ...address, text: found?.text ?? "", index: index + 1, observed: !!found }
          })
          return respond({ kind: "queue", target: view.target, viewID: view.id, items, incomplete: view.incomplete,
            ...(sameTarget(view.target, destination) && live.state ? { state: live.state } : {}) })
        }
        catch { return respond({ kind: "unavailable", target: destination }) }
      }
      if (!["bind", "unbind", "unqueue"].includes(command.action)) return respond({ kind: "unsupported" })
      const key = "control:" + originKey(input.scope, input.messageID)
      const done = "control-receipt:" + originKey(input.scope, input.messageID)
      const old = await storage.get(key)
      if (old !== undefined) {
        const plan = parse(old)
        if (plan.fingerprint !== fingerprint(input) || plan.action !== command.action) return respond({ kind: "conflict" })
        if (plan.target && !allowedTarget(plan.target)) return respond({ kind: "forbidden" })
        duplicate = true
        return respond(await readReceipt(done, plan))
      }
      // A previous classification/refusal or crash before a write intent is not permission to execute an old command.
      // Only the first ingress attempt may create a mutation intent; later delivery can only observe one.
      if (duplicate) return respond({ kind: "uncertain" })
      let destination: Target | undefined, wanted: string | undefined, nativeID: string | undefined, viewID: string | undefined
      if (command.action === "unbind") {
        if (args) return respond({ kind: "invalid" })
      } else if (command.action === "bind") {
        const parts = args.split(/\s+/)
        if (parts.length === 1 && /^\d+$/.test(parts[0]!)) {
          const found = await selection.select(input, "conversations", parts[0]!)
          if (found.kind !== "selected") return respond(found)
          destination = found.target; viewID = found.view.id
        } else if (parts.length === 1 && id(parts[0])) destination = target(parts[0])
        else if (parts.length === 2 && parts[0]?.toLowerCase() === "session" && id(parts[1])) destination = target(parts[1])
        else if (parts.length === 3 && parts[0]?.toLowerCase() === "backend" && id(parts[1]) && id(parts[2])) destination = target({ kind: "backend", ref: { backendID: parts[1], threadID: parts[2] } })
        else return respond({ kind: "invalid" })
      } else {
        destination = await options.binding(input.scope)
        if (!destination) return respond({ kind: "unbound" })
        if (args) {
          if (/^\d+$/.test(args)) {
            const found = await selection.select(input, "queue", args)
            if (found.kind !== "selected") return respond(found)
            if (!sameTarget(found.target, destination) || !found.address) return respond({ kind: "conflict" })
            wanted = found.address.inputID; nativeID = found.address.nativeID; viewID = found.view.id
          } else {
            if (!id(args)) return respond({ kind: "invalid" })
            wanted = args
          }
        } else if (input.quoteID) {
          const quoted = await options.lookup(input.scope, input.quoteID)
          if (!quoted || !sameTarget(destination, quoted.target) || quoted.amendmentID || quoted.continuationID) return respond({ kind: "conflict" })
          wanted = quoted.inputID
        } else return respond({ kind: "invalid" })
      }
      if (destination && !allowedTarget(destination)) return respond({ kind: "forbidden" })
      const plan: Plan = { fingerprint: fingerprint(input), action: command.action as Plan["action"], ...(destination ? { target: destination } : {}), ...(wanted ? { inputID: wanted } : {}),
        ...(nativeID ? { nativeID } : {}), ...(viewID ? { viewID } : {}) }
      // First writer freezes the command's target. Never repeat a possibly completed mutation after restart or lost acknowledgment.
      if (!await storage.insert(key, plan)) {
        const winner = parse(await storage.get(key))
        if (winner.fingerprint !== plan.fingerprint || winner.action !== plan.action) return respond({ kind: "conflict" })
        if (winner.target && !allowedTarget(winner.target)) return respond({ kind: "forbidden" })
        duplicate = true
        return respond(await readReceipt(done, winner))
      }
      let result: ControlResult
      if (plan.action === "bind") {
        await options.bind(input.scope, plan.target)
        result = { kind: "bound", target: plan.target! }
      } else if (plan.action === "unbind") {
        await options.bind(input.scope)
        result = { kind: "unbound-applied" }
      } else {
        const destination = plan.target!
        let resultNative: "withdrawn" | "unchanged" | "uncertain"
        if (plan.nativeID && destination.kind === "backend") {
          if (!backend) throw new Error("Backend unavailable")
          const receipt = await backend.control({ backendID: destination.ref.backendID,
            control: { action: "withdraw", threadID: destination.ref.threadID, nativeID: plan.nativeID } })
          if (receipt.status === "applied") await options.onWithdrawal?.({ target: destination, inputID: plan.inputID!, nativeID: plan.nativeID })
          resultNative = receipt.status === "applied" ? "withdrawn" : receipt.status === "not-found" ? "unchanged" : "uncertain"
        } else {
          const user = destination.kind !== "session" || (await queue(destination)).items.some((item) => item.inputID === plan.inputID)
          resultNative = user ? await native.withdraw(destination, plan.inputID!) : "unchanged"
        }
        result = resultNative === "withdrawn" ? { kind: "withdraw-requested", target: plan.target!, inputID: plan.inputID! }
          : { kind: resultNative === "unchanged" ? "unchanged" : "uncertain" }
      }
      // Do not persist live queue/history bodies. An unknown mutation never gains a success receipt or a replay worker.
      if (result.kind !== "uncertain") await storage.insert(done, result)
      return respond(result)
    } catch { return respond({ kind: "uncertain" }) }
  }
  return { receive, publishView: selection.publish }
}
