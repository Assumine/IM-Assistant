import { createHash } from "node:crypto"
import { openOneBot, decodeImage, imageFrameBytes, inlineImage, maximumImageBytes, type OneBotOptions, type Source, type OutgoingPart } from "../../qq-protocol/src/index"
import { createChatbotModule } from "./module"
import { nativeSessionID, nativeInputID, scopeIdentity } from "./sessions"
import { accountID, messageID, record, policy, decode, directed, type ChatPolicy } from "./policy"
import { parseReply, replyProtocol, type Sticker } from "./replies"
import type { Account, Context, Receipt } from "./types"

export type ChannelAccount = Account & { connection: Omit<OneBotOptions, "botID">; policy: ChatPolicy;
  images?: { maxBytes: number }; stickers?: readonly Sticker[] }
export type ChatIssue = { kind: "unsupported" | "overloaded" | "admission" | "image-unavailable" | "image-model-unsupported" | "invalid-reply" | "send-uncertain" | "metadata" | "native-output" | "event-stream"; botID?: string }
type Watch = { version: 1; source: Source; sessionID: string; inputID: string; revision: number }
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const memberKey = (source: Source, member: string) => "chat-member:" + scopeIdentity(source.scope) + ":" + member
const watchKey = (id: string) => "chat-watch:" + id

/** Optional QQ ingress/output resource. Native Session/Inbox remain the only execution owners. */
export function createQQChatbot(options: { location: { directory: string }; accounts: readonly ChannelAccount[]; onIssue?: (issue: ChatIssue) => void;
  onInput?: (source: Source, receipt: Receipt) => void }) {
  const accounts = options.accounts.map((value) => {
    const rules = policy(value.policy), stickers = structuredClone(value.stickers ?? [])
    if (value.images && (!Number.isSafeInteger(value.images.maxBytes) || value.images.maxBytes < 1 || value.images.maxBytes > maximumImageBytes) ||
      stickers.length > 32 || new Set(stickers.map((item) => item.id)).size !== stickers.length ||
      stickers.some((item) => !/^[a-z][a-z0-9_-]{0,31}$/.test(item.id) || !item.label.trim() || item.label.length > 80 || !inlineImage(item.uri, 2 * 1024 * 1024)))
      throw new Error("Invalid QQ chat media configuration")
    return { ...structuredClone(value), rules, stickers }
  })
  const base = createChatbotModule({ location: options.location, accounts: accounts.map((account) => ({ ...account,
    persona: { name: account.persona.name, prompt: account.persona.prompt + "\n\n" + replyProtocol + "\nApproved stickers: " +
      JSON.stringify(account.stickers.map(({ id, label }) => ({ id, label }))) } })) })
  const runtime = new Map(accounts.map((account) => [account.botID, { enabled: account.rules.repliesEnabled, revision: 0 }]))
  const ready = Promise.withResolvers<"ready" | "degraded" | "unavailable" | "closed">()
  let context: Context | undefined, closed = false, opened = false, switchesReady = false, writes = Promise.resolve()
  const wires = new Map<string, ReturnType<typeof openOneBot>>(), watches = new Map<string, Watch>()
  const jobs = new Set<Promise<unknown>>(), lanes = new Map<string, Promise<void>>()
  const checking = new Map<string, { dirty: boolean; promise: Promise<void> }>()
  const controller = new AbortController()
  const issue = (kind: ChatIssue["kind"], botID?: string) => { try { options.onIssue?.({ kind, ...(botID ? { botID } : {}) }) } catch { /* Observation only. */ } }
  const track = <T>(job: Promise<T>) => { jobs.add(job); void job.finally(() => jobs.delete(job)); return job }
  const gate = (watch: Watch) => !closed && runtime.get(watch.source.scope.botID)?.enabled === true && runtime.get(watch.source.scope.botID)?.revision === watch.revision
  const permitted = (source: Source) => {
    const account = accounts.find((item) => item.botID === source.scope.botID)
    return !!account && accountID(source.actorID) && accountID(source.scope.peerID) && messageID(source.messageID) &&
      !accounts.some((item) => item.botID === source.actorID) && !account.rules.ignoredUsers.includes(source.actorID) &&
      (source.scope.kind === "private" ? source.scope.peerID === source.actorID && account.rules.privateUsers.includes(source.actorID)
        : source.scope.kind === "group" && account.rules.groups.includes(source.scope.peerID))
  }
  const finish = async (watch: Watch) => {
    await context!.storage.insert("chat-finished:" + watch.inputID, { version: 1, source: watch.source })
    await context!.storage.remove(watchKey(watch.inputID)); watches.delete(watch.inputID)
  }
  const check = async (watch: Watch) => {
    if (closed || !context || wires.get(watch.source.scope.botID)?.state().phase !== "online") return
    if (!permitted(watch.source) || !gate(watch)) { await finish(watch); return }
    const output = await context.client.experimental.session.input.output({ sessionID: watch.sessionID, inputID: watch.inputID }, { signal: controller.signal })
    if (output.status !== "closed") return
    if (output.inputID !== watch.inputID || output.rootID !== watch.inputID || output.sessionID !== watch.sessionID || !output.last?.settled) { issue("native-output", watch.source.scope.botID); await finish(watch); return }
    const user = await context.client.session.message.get({ sessionID: watch.sessionID, messageID: watch.inputID }, { signal: controller.signal })
    const origin = user.type === "user" ? user.metadata?.qqChatbot : undefined
    if (!record(origin) || origin.actorID !== watch.source.actorID || origin.messageID !== watch.source.messageID || !record(origin.scope) ||
      origin.scope.botID !== watch.source.scope.botID || origin.scope.kind !== watch.source.scope.kind || origin.scope.peerID !== watch.source.scope.peerID) {
      issue("metadata", watch.source.scope.botID); await finish(watch); return
    }
    const packets = parseReply(output.last.text), account = accounts.find((item) => item.botID === watch.source.scope.botID)!
    if (!packets) { issue("invalid-reply", account.botID); await finish(watch); return }
    const plans: OutgoingPart[][] = []
    for (const packet of packets) {
      const parts: OutgoingPart[] = []
      for (const member of packet.mentions ?? []) {
        if (watch.source.scope.kind !== "group" || !await context.storage.get(memberKey(watch.source, member))) {
          issue("invalid-reply", account.botID); await finish(watch); return
        }
        parts.push({ type: "mention", memberID: member })
      }
      if (packet.text) parts.push({ type: "text", text: packet.text })
      if (packet.sticker) {
        const sticker = account.stickers.find((item) => item.id === packet.sticker)
        if (!sticker) { issue("invalid-reply", account.botID); await finish(watch); return }
        parts.push({ type: "image", uri: sticker.uri })
      }
      plans.push(parts)
    }
    for (let index = 0; index < plans.length; index++) {
      if (!gate(watch)) { await finish(watch); return }
      const key = "chat-output:" + watch.inputID + ":" + index, digest = hash([watch.source, output.last.messageID, plans[index]])
      const fresh = await context.storage.insert(key, { version: 1, hash: digest })
      if (!fresh) {
        const prior = await context.storage.get(key), receipt = await context.storage.get(key + ":receipt")
        // An existing intent may have reached QQ. Never resend it, including after an unknown receipt.
        if (!record(prior) || prior.hash !== digest || !record(receipt) || receipt.hash !== digest || receipt.status !== "sent") {
          issue("send-uncertain", account.botID); await finish(watch); return
        }
        continue
      }
      if (!gate(watch)) { await finish(watch); return }
      const result = await wires.get(account.botID)!.sendMessage(watch.source.scope, plans[index]!, index === 0 ? watch.source.messageID : undefined)
      await context.storage.insert(key + ":receipt", { ...result, hash: digest })
      if (result.status !== "sent") { issue("send-uncertain", account.botID); await finish(watch); return }
      await context.storage.insert("chat-own-reply:" + scopeIdentity(watch.source.scope) + ":" + result.messageID,
        { inputID: watch.inputID, source: watch.source })
    }
    await finish(watch)
  }
  const schedule = (watch: Watch) => {
    const pending = checking.get(watch.inputID)
    if (pending) { pending.dirty = true; return }
    const state = { dirty: false, promise: Promise.resolve() }
    state.promise = track((async () => {
      try { do { state.dirty = false; await check(watch) } while (state.dirty && !closed && watches.has(watch.inputID)) }
      catch { if (!closed) issue("metadata", watch.source.scope.botID) }
      finally { checking.delete(watch.inputID) }
    })())
    checking.set(watch.inputID, state)
  }
  const restore = async () => {
    let after: string | undefined
    do {
      const page = await context!.storage.scan({ prefix: "chat-watch:", limit: 128, ...(after ? { after } : {}) })
      for (const entry of page.entries) {
        const value = entry.value
        if (!record(value) || value.version !== 1 || !record(value.source) || !record(value.source.scope) ||
          typeof value.sessionID !== "string" || typeof value.inputID !== "string" || !Number.isSafeInteger(value.revision)) { issue("metadata"); continue }
        const watch = value as unknown as Watch
        if (!permitted(watch.source) || watch.sessionID !== nativeSessionID(watch.source.scope) || entry.key !== watchKey(watch.inputID) ||
          watch.inputID !== nativeInputID(watch.source)) { issue("metadata"); continue }
        watches.set(watch.inputID, watch); schedule(watch)
      }
      if (page.next === after && after) throw new Error("Repeated native metadata cursor")
      after = page.next
    } while (after && !closed)
  }
  const consume = async (account: typeof accounts[number], raw: unknown) => {
    if (closed) return
    const input = decode(raw, account.botID, account.rules, accounts.map((item) => item.botID))
    if (typeof input === "string") { if (input === "unsupported") issue("unsupported", account.botID); return }
    const source: Source = { scope: input.scope, actorID: input.actorID, messageID: input.messageID }
    if (source.scope.kind === "group") await context!.storage.insert(memberKey(source, source.actorID), { version: 1, memberID: source.actorID })
    const state = runtime.get(account.botID)!, revision = state.revision
    const isDirected = directed(input, account.persona.name) || !!(input.quoteID && await context!.storage.get("chat-own-reply:" + scopeIdentity(input.scope) + ":" + input.quoteID))
    const busy = [...watches.values()].some((watch) => watch.sessionID === nativeSessionID(input.scope))
    let respond = state.enabled && (input.scope.kind === "private" || account.rules.groupReplies !== "off" &&
      (isDirected || account.rules.groupReplies === "auto" && !busy))
    const files = []
    if (respond && input.images?.length) {
      if (!base.supportsImages(account.botID)) { respond = false; issue("image-model-unsupported", account.botID) }
      else if (!account.images) { respond = false; issue("image-unavailable", account.botID) }
      else {
        let bytes = 0
        for (const file of input.images) {
          const image = decodeImage(file, await wires.get(account.botID)!.image(source, file), account.images.maxBytes - bytes)
          if (!image) { respond = false; issue("image-unavailable", account.botID); break }
          bytes += image.byteLength
          files.push({ uri: image.uri, name: image.name, source: { type: "inline" as const } })
        }
      }
    }
    if (closed) return
    if (respond && watches.size >= 512) { respond = false; issue("overloaded", account.botID) }
    respond = respond && state.enabled && state.revision === revision
    const receipt = await (respond ? base.receive({ ...input, ...(files.length ? { files } : {}) }) : base.observe(input))
    try { options.onInput?.(structuredClone(source), structuredClone(receipt)) } catch { /* Observation only. */ }
    if (receipt.status !== "accepted") { if (receipt.status !== "observed") issue("admission", account.botID); return }
    if (!respond || closed || await context!.storage.get("chat-finished:" + receipt.inputID)) return
    const watch: Watch = { version: 1, source, inputID: receipt.inputID, sessionID: receipt.sessionID, revision }
    if (watches.size >= 512) { issue("overloaded", account.botID); return }
    await context!.storage.insert(watchKey(receipt.inputID), watch)
    watches.set(receipt.inputID, watch); schedule(watch)
  }
  return {
    id: base.id, title: base.title, ready: ready.promise,
    replies: (botID: string) => runtime.has(botID) ? { ...runtime.get(botID)! } : undefined,
    async setReplies(botID: string, enabled: boolean) {
      if (closed || !context || !switchesReady || !runtime.has(botID) || typeof enabled !== "boolean") throw new Error("Chat reply switch is unavailable")
      const state = runtime.get(botID)!
      if (state.enabled !== enabled) { state.enabled = enabled; state.revision++ }
      const saved = { enabled: state.enabled, revision: state.revision }
      const save = writes.then(() => context!.storage.set("chat-switch:" + botID, saved))
      writes = save.catch(() => { issue("metadata", botID) })
      await save
      for (const watch of watches.values()) if (watch.source.scope.botID === botID) schedule(watch)
    },
    open(value: Context) {
      if (opened) throw new Error("QQ chat channel already opened")
      opened = true; context = value
      let nativeHealth = "starting"
      const report = () => {
        if (closed) return
        const online = accounts.filter((account) => base.isAvailable(account.botID) && wires.get(account.botID)?.state().phase === "online").length
        value.capability.report({ phase: online === accounts.length && nativeHealth === "ready" ? "ready" : online ? "degraded"
          : nativeHealth === "starting" || [...wires.values()].some((wire) => ["connecting", "verifying"].includes(wire.state().phase)) ? "starting" : "unavailable" })
      }
      const resource = base.open({ ...value, capability: { ...value.capability, report: (health) => { nativeHealth = health.phase; report() } } })
      let observing = Promise.resolve()
      const startup = (async () => {
        const native = await base.ready
        if (closed || native === "closed") return
        if (native === "unavailable") { ready.resolve("unavailable"); return }
        for (const account of accounts) {
          const saved = await value.storage.get("chat-switch:" + account.botID)
          if (record(saved) && typeof saved.enabled === "boolean" && Number.isSafeInteger(saved.revision)) runtime.set(account.botID, { enabled: saved.enabled, revision: saved.revision as number })
        }
        if (closed) return
        switchesReady = true
        const connected = Promise.withResolvers<boolean>()
        observing = (async () => {
          try {
            for await (const event of value.client.event.subscribe({ signal: controller.signal, types: ["session.input.closed", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"] })) {
              if (closed) break
              if (event.type === "server.connected") { connected.resolve(true); await restore(); continue }
              if ("sessionID" in event.data) for (const watch of watches.values()) if (watch.sessionID === event.data.sessionID) schedule(watch)
            }
          } catch { if (!closed) issue("event-stream") }
          finally { connected.resolve(false) }
        })()
        if (!await connected.promise || closed) { ready.resolve("unavailable"); return }
        for (const account of accounts) {
          if (!base.isAvailable(account.botID) || closed) continue
          const wire = openOneBot({ ...account.connection, botID: account.botID,
            maxFrameBytes: imageFrameBytes(Math.max(account.images?.maxBytes ?? 0, account.stickers.length ? 2 * 1024 * 1024 : 0, 262144)) }, {
            event(raw) {
              if (closed) return
              const decoded = decode(raw, account.botID, account.rules, accounts.map((item) => item.botID))
              if (typeof decoded === "string") { if (decoded === "unsupported") issue("unsupported", account.botID); return }
              if (jobs.size >= 128) { issue("overloaded", account.botID); return }
              const key = scopeIdentity(decoded.scope)
              const pending = (lanes.get(key) ?? Promise.resolve()).then(() => consume(account, raw)).catch(() => { if (!closed) issue("metadata", account.botID) })
              lanes.set(key, pending); track(pending)
              void pending.finally(() => { if (lanes.get(key) === pending) lanes.delete(key) })
            }, state() { report(); for (const watch of watches.values()) if (watch.source.scope.botID === account.botID) schedule(watch) },
          })
          wires.set(account.botID, wire)
        }
        await Promise.all([...wires.values()].map((wire) => wire.ready))
        report()
        const online = [...wires.values()].filter((wire) => wire.state().phase === "online").length
        ready.resolve(online === accounts.length && native === "ready" ? "ready" : online ? "degraded" : "unavailable")
      })().catch(() => { if (!closed) { issue("metadata"); value.capability.report({ phase: "unavailable" }); ready.resolve("unavailable") } })
      return { async close() {
        closed = true; ready.resolve("closed"); controller.abort()
        for (const wire of wires.values()) wire.close()
        await resource.close(); await Promise.allSettled([startup, observing, writes, ...jobs])
      } }
    },
  }
}
