import type { StorageDomain } from "../../../opencode/packages/plugin/src/promise/storage"
import { fingerprint, inputID, originKey, type Message, type Policy, type Scope } from "./routing"
import { sameTarget, target, targets, type Native, type Backend, type Target } from "./target"
import type { Origin } from "./sources"

type Storage = Pick<StorageDomain, "get" | "set" | "insert">
export type ControlOptions = { allowedUsers: readonly string[]; backendIDs?: readonly string[] }
type Row = { inputID: string; text: string }
export type ControlResult =
  | { kind: "forbidden" | "unsupported" | "invalid" | "unbound" | "uncertain" | "conflict" | "unchanged" }
  | { kind: "help"; commands: string[] }
  | { kind: "bound"; target: Target }
  | { kind: "unbound-applied" }
  | { kind: "withdraw-requested"; target: Target; inputID: string }
  | { kind: "unavailable"; target: Target }
  | { kind: "conversations"; items: { target: Target; title: string }[]; incomplete: boolean; unavailable: string[] }
  | { kind: "queue" | "status"; target: Target; items: Row[]; incomplete: boolean; state?: string }
export type ControlResponse = { status: "control"; action: string; commandID: string; duplicate: boolean; result: ControlResult }
type Plan = { fingerprint: string; action: "bind" | "unbind" | "unqueue"; target?: Target; inputID?: string }
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
}) {
  const { storage, session, backend, permissions } = options
  const native = targets(session, backend)
  const allowedTarget = (value: Target) => value.kind === "session" || !!permissions.backendIDs?.includes(value.ref.backendID)
  const parse = (value: unknown): Plan => {
    if (!record(value) || !digest(value.fingerprint) || !["bind", "unbind", "unqueue"].includes(String(value.action)) ||
      Object.keys(value).some((key) => !["fingerprint", "action", "target", "inputID"].includes(key))) throw new Error("Invalid control intent")
    const destination = value.target === undefined ? undefined : target(value.target)
    if (value.action === "unbind" ? destination !== undefined || value.inputID !== undefined : !destination ||
      (value.action === "unqueue" ? !id(value.inputID) : value.inputID !== undefined)) throw new Error("Invalid control target")
    return value as Plan
  }
  const queue = async (destination: Target): Promise<{ items: Row[]; incomplete: boolean; state?: string }> => {
    if (!allowedTarget(destination)) throw new Error("Backend is not authorized")
    if (destination.kind === "session") {
      await native.validate(destination)
      const items = await session.inbox.list({ sessionID: destination.sessionID })
      if (items.some((item) => item.sessionID !== destination.sessionID)) throw new Error("Wrong Session inbox")
      return { items: items.flatMap((item) => item.type === "user" ? [{ inputID: item.id, text: item.payload.text }] : []), incomplete: false }
    }
    if (!backend) throw new Error("Backend unavailable")
    const snapshot = await backend.execution({ ref: destination.ref, limit: 100 })
    if (!sameTarget(destination, { kind: "backend", ref: snapshot.thread.ref })) throw new Error("Wrong backend execution")
    if (new Set(snapshot.queue.map((item) => item.inputID)).size !== snapshot.queue.length) throw new Error("Ambiguous native queue")
    return { items: snapshot.queue.map((item) => ({ inputID: item.inputID, text: item.text })), incomplete: !!snapshot.nextCursor, state: snapshot.thread.state }
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
  return async (input: Message, command: { action: string; arguments: string }, duplicate: boolean): Promise<ControlResponse> => {
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
        return respond({ kind: "conversations", items, incomplete, unavailable })
      }
      if ((command.action === "queue" || command.action === "status") && !args) {
        const destination = await options.binding(input.scope)
        if (!destination) return respond({ kind: "unbound" })
        if (!allowedTarget(destination)) return respond({ kind: "forbidden" })
        try { return respond({ kind: command.action, target: destination, ...await queue(destination) }) }
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
      let destination: Target | undefined, wanted: string | undefined
      if (command.action === "unbind") {
        if (args) return respond({ kind: "invalid" })
      } else if (command.action === "bind") {
        const parts = args.split(/\s+/)
        if (parts.length === 1 && id(parts[0]) && !/^\d+$/.test(parts[0])) destination = target(parts[0])
        else if (parts.length === 2 && parts[0].toLowerCase() === "session" && id(parts[1])) destination = target(parts[1])
        else if (parts.length === 3 && parts[0].toLowerCase() === "backend" && id(parts[1]) && id(parts[2])) destination = target({ kind: "backend", ref: { backendID: parts[1], threadID: parts[2] } })
        else return respond({ kind: "invalid" })
      } else {
        destination = await options.binding(input.scope)
        if (!destination) return respond({ kind: "unbound" })
        if (args) {
          if (!id(args) || /^\d+$/.test(args)) return respond({ kind: "invalid" })
          wanted = args
        } else if (input.quoteID) {
          const quoted = await options.lookup(input.scope, input.quoteID)
          if (!quoted || !sameTarget(destination, quoted.target) || quoted.amendmentID || quoted.continuationID) return respond({ kind: "conflict" })
          wanted = quoted.inputID
        } else return respond({ kind: "invalid" })
      }
      if (destination && !allowedTarget(destination)) return respond({ kind: "forbidden" })
      const plan: Plan = { fingerprint: fingerprint(input), action: command.action as Plan["action"], ...(destination ? { target: destination } : {}), ...(wanted ? { inputID: wanted } : {}) }
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
        const user = destination.kind !== "session" || (await queue(destination)).items.some((item) => item.inputID === plan.inputID)
        const resultNative = user ? await native.withdraw(destination, plan.inputID!) : "unchanged"
        result = resultNative === "withdrawn" ? { kind: "withdraw-requested", target: plan.target!, inputID: plan.inputID! }
          : { kind: resultNative === "unchanged" ? "unchanged" : "uncertain" }
      }
      // Do not persist live queue/history bodies. An unknown mutation never gains a success receipt or a replay worker.
      if (result.kind !== "uncertain") await storage.insert(done, result)
      return respond(result)
    } catch { return respond({ kind: "uncertain" }) }
  }
}
