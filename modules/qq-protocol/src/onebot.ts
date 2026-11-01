import { randomUUID } from "node:crypto"
import type { Scope, Source } from "./types"
import { imageFile, imageFrameBytes, maximumImageBytes } from "./images"

export type WireState = { phase: "connecting" | "verifying" | "online" | "unavailable" | "closed"; reason?: "configuration" | "transport" | "deadline" | "identity" | "not-online" | "protocol" | "account-in-use" }
export type SendResult = { status: "sent"; messageID: string } | { status: "unavailable" | "uncertain" | "rejected" }
export type RecallResult = { status: "recalled" | "unavailable" | "uncertain" | "rejected" }
export type OneBotOptions = {
  url: string; token: string; botID: string; connectTimeoutMs?: number; requestTimeoutMs?: number; maxFrameBytes?: number; maxRequests?: number
}
type Reply = { status: "ok" | "failed" | "async"; retcode: number; data: unknown }
type Answer = { kind: "reply"; reply: Reply } | { kind: "unknown" | "not-sent" }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const accountID = (value: unknown) => (typeof value === "string" || typeof value === "number" && Number.isSafeInteger(value)) && /^[1-9][0-9]{0,19}$/.test(String(value)) ? String(value) : undefined
const numericID = (value: unknown) => (typeof value === "string" || typeof value === "number" && Number.isSafeInteger(value)) && /^-?(?:0|[1-9][0-9]{0,19})$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? String(value) : undefined
const bounded = (value: number | undefined, fallback: number, maximum: number) => value === undefined ? fallback : Number.isSafeInteger(value) && value >= 1 && value <= maximum ? value : undefined
// Both business plugins run in one ApplicationScope. Never let a second consumer steal an account.
// This is a connection lease, not a message queue or a cross-process login lock.
const accounts = new Map<string, symbol>()

/** One explicit forward/universal OneBot-11 connection. No login, polling, automatic reconnect or API replay. */
export function openOneBot(options: OneBotOptions, callbacks: { event: (event: unknown) => void; state?: (state: WireState) => void }) {
  const lease = Symbol()
  let current: WireState = { phase: "connecting" }, stopped = false
  let socket: WebSocket | undefined, startup: ReturnType<typeof setTimeout> | undefined
  const ready = Promise.withResolvers<WireState>()
  const pending = new Map<string, { finish: (value: Answer) => void; timer: ReturnType<typeof setTimeout> }>()
  let requestTimeout = 5000, maxFrame = 262144, maxRequests = 32
  const update = (value: WireState) => {
    current = value
    try { callbacks.state?.({ ...value }) } catch { /* Observers cannot break the transport. */ }
  }
  const stop = (phase: "unavailable" | "closed", reason?: WireState["reason"]) => {
    if (stopped) { if (phase === "closed" && current.phase !== "closed") update({ phase }); return }
    stopped = true; clearTimeout(startup)
    if (accounts.get(options.botID) === lease) accounts.delete(options.botID)
    for (const value of pending.values()) { clearTimeout(value.timer); value.finish({ kind: "unknown" }) }
    pending.clear()
    update({ phase, ...(reason ? { reason } : {}) }); ready.resolve({ ...current })
    try { socket?.close() } catch { /* No credential-bearing exception leaves this boundary. */ }
  }
  const request = (action: string, params: Record<string, unknown>, timeout = requestTimeout): Promise<Answer> => {
    if (stopped || socket?.readyState !== WebSocket.OPEN || pending.size >= maxRequests) return Promise.resolve({ kind: "not-sent" })
    const echo = randomUUID(), text = JSON.stringify({ action, params, echo })
    if (Buffer.byteLength(text) > maxFrame) return Promise.resolve({ kind: "not-sent" })
    return new Promise((resolve) => {
      const timer = setTimeout(() => { pending.delete(echo); resolve({ kind: "unknown" }) }, timeout)
      pending.set(echo, { finish: resolve, timer })
      try { socket!.send(text) } catch { stop("unavailable", "transport") }
    })
  }
  const verify = async () => {
    const login = await request("get_login_info", {})
    if (stopped) return
    if (login.kind !== "reply" || login.reply.status !== "ok" || !record(login.reply.data)) { stop("unavailable", "protocol"); return }
    if (accountID(login.reply.data.user_id) !== options.botID) { stop("unavailable", "identity"); return }
    const status = await request("get_status", {})
    if (stopped) return
    if (status.kind !== "reply" || status.reply.status !== "ok" || !record(status.reply.data)) { stop("unavailable", "protocol"); return }
    if (status.reply.data.online !== true || status.reply.data.good !== true) { stop("unavailable", "not-online"); return }
    clearTimeout(startup); update({ phase: "online" }); ready.resolve({ ...current })
  }
  const message = (event: MessageEvent) => {
    if (stopped) return
    if (typeof event.data !== "string" || Buffer.byteLength(event.data) > maxFrame) { stop("unavailable", "protocol"); return }
    let value: unknown
    try { value = JSON.parse(event.data) } catch { stop("unavailable", "protocol"); return }
    if (!record(value)) { stop("unavailable", "protocol"); return }
    if (value.post_type !== undefined) {
      if (value.echo !== undefined) { stop("unavailable", "protocol"); return }
      if (accountID(value.self_id) !== options.botID) { stop("unavailable", "identity"); return }
      if (current.phase !== "online") return
      if (value.post_type === "meta_event" && value.meta_event_type === "heartbeat" && record(value.status)) {
        if (value.status.online === false || value.status.good === false) stop("unavailable", "not-online")
        return
      }
      try { callbacks.event(value) } catch { stop("unavailable", "protocol") }
      return
    }
    if (typeof value.echo !== "string") return
    const waiting = pending.get(value.echo)
    if (!waiting) return
    if (!Number.isSafeInteger(value.retcode) || (value.status !== "ok" && value.status !== "failed" && value.status !== "async") ||
      (value.status === "ok" ? value.retcode !== 0 : value.status === "async" ? value.retcode !== 1 : value.retcode === 0 || value.retcode === 1)) {
      stop("unavailable", "protocol"); return
    }
    pending.delete(value.echo); clearTimeout(waiting.timer)
    waiting.finish({ kind: "reply", reply: { status: value.status as Reply["status"], retcode: value.retcode as number, data: value.data } })
  }
  queueMicrotask(() => {
    try {
      const url = new URL(options.url), connectTimeout = bounded(options.connectTimeoutMs, 5000, 60000)
      const timeout = bounded(options.requestTimeoutMs, 5000, 60000), frame = bounded(options.maxFrameBytes, 262144, imageFrameBytes(maximumImageBytes)), requests = bounded(options.maxRequests, 32, 128)
      if (typeof Bun === "undefined" || !accountID(options.botID) || typeof options.token !== "string" || !options.token.length || options.token.length > 4096 ||
        /[\r\n]/.test(options.token) || url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
        !["ws:", "wss:"].includes(url.protocol) || url.protocol === "ws:" && !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
        !connectTimeout || !timeout || !frame || !requests) { stop("unavailable", "configuration"); return }
      if (stopped) return
      if (accounts.has(options.botID)) { stop("unavailable", "account-in-use"); return }
      accounts.set(options.botID, lease)
      requestTimeout = timeout; maxFrame = frame; maxRequests = requests
      // Bun provides the authenticated overload hidden by lib.dom. Never silently fall back to an unauthenticated browser socket.
      const Client = WebSocket as typeof WebSocket & { new(url: string, options: Bun.WebSocketOptions): WebSocket }
      socket = new Client(url.href, { headers: { Authorization: "Bearer " + options.token } })
      startup = setTimeout(() => stop("unavailable", "deadline"), connectTimeout)
      socket.addEventListener("open", () => { if (!stopped) { update({ phase: "verifying" }); void verify().catch(() => stop("unavailable", "protocol")) } })
      socket.addEventListener("message", message)
      socket.addEventListener("error", () => stop("unavailable", "transport"))
      socket.addEventListener("close", () => stop("unavailable", "transport"))
    } catch { stop("unavailable", "configuration") }
  })
  return {
    ready: ready.promise,
    state: (): WireState => ({ ...current }),
    close() { stop("closed") },
    /** Host-only notification cleanup. Callers must retain proof that this ID is their own acknowledged output. */
    async recall(source: Source, messageID: string): Promise<RecallResult> {
      const id = numericID(messageID)
      if (current.phase !== "online" || source.scope.botID !== options.botID || !id || !accountID(source.actorID) ||
        !accountID(source.scope.peerID) || !["private", "group"].includes(source.scope.kind) ||
        source.scope.kind === "private" && source.scope.peerID !== source.actorID) return { status: "unavailable" }
      const response = await request("delete_msg", { message_id: Number(id) })
      return { status: response.kind === "not-sent" ? "unavailable" : response.kind !== "reply" ? "uncertain"
        : response.reply.status === "ok" ? "recalled" : response.reply.status === "failed" ? "rejected" : "uncertain" }
    },
    /** Received content identifier only. Returned path/URL fields are never opened. */
    async image(source: Source, file: string): Promise<unknown> {
      if (current.phase !== "online" || source.scope.botID !== options.botID || !accountID(source.actorID) ||
        !accountID(source.scope.peerID) || !["private", "group"].includes(source.scope.kind) ||
        source.scope.kind === "private" && source.scope.peerID !== source.actorID || !imageFile(file)) return undefined
      const response = await request("get_image", { file }, 30000)
      return response.kind === "reply" && response.reply.status === "ok" ? response.reply.data : undefined
    },
    /** Explicit NapCat history capability. Its message_seq is an opaque short-ID anchor, not an ordering key. */
    async history(scope: Scope, before: string | undefined, count: number): Promise<unknown[] | undefined> {
      if (current.phase !== "online" || scope.botID !== options.botID || !accountID(scope.peerID) ||
        !["private", "group"].includes(scope.kind) || before !== undefined && !numericID(before) ||
        !Number.isSafeInteger(count) || count < 2 || count > 100) return undefined
      const response = await request(scope.kind === "private" ? "get_friend_msg_history" : "get_group_msg_history", {
        [scope.kind === "private" ? "user_id" : "group_id"]: scope.peerID,
        ...(before !== undefined ? { message_seq: before } : {}), count, reverse_order: false,
        parse_mult_msg: false, disable_get_url: true, quick_reply: false,
      })
      return response.kind === "reply" && response.reply.status === "ok" && record(response.reply.data) && Array.isArray(response.reply.data.messages)
        ? response.reply.data.messages : undefined
    },
    /** Read the exact retained source, not arbitrary history. get_msg has no required group_id in OneBot 11. */
    async read(source: Source): Promise<unknown | undefined> {
      const id = numericID(source.messageID)
      if (current.phase !== "online" || source.scope.botID !== options.botID || !id || !accountID(source.actorID) ||
        !accountID(source.scope.peerID) || !["private", "group"].includes(source.scope.kind) ||
        source.scope.kind === "private" && source.scope.peerID !== source.actorID) return undefined
      const response = await request("get_msg", { message_id: Number(id) })
      if (response.kind !== "reply" || response.reply.status !== "ok" || !record(response.reply.data)) return undefined
      const data = response.reply.data
      if (numericID(data.message_id) !== id || data.message_type !== source.scope.kind || !record(data.sender) ||
        accountID(data.sender.user_id) !== source.actorID || !Array.isArray(data.message) ||
        data.group_id !== undefined && (source.scope.kind !== "group" || accountID(data.group_id) !== source.scope.peerID) ||
        data.user_id !== undefined && accountID(data.user_id) !== source.actorID) return undefined
      // Scope comes from the already-retained source. The consumer must still verify its original fingerprint.
      return { post_type: "message", self_id: options.botID, message_type: source.scope.kind, user_id: source.actorID,
        message_id: id, ...(source.scope.kind === "group" ? { group_id: source.scope.peerID } : {}), message: data.message }
    },
    async send(scope: Scope, text: string, quoteID: string): Promise<SendResult> {
      const peer = accountID(scope.peerID)
      if (current.phase !== "online" || scope.botID !== options.botID || !["private", "group"].includes(scope.kind) || !peer ||
        !Number.isSafeInteger(Number(peer)) || typeof text !== "string" || !text.trim() || text.length > 16000 || !numericID(quoteID)) return { status: "unavailable" }
      const response = await request(scope.kind === "private" ? "send_private_msg" : "send_group_msg", {
        [scope.kind === "private" ? "user_id" : "group_id"]: Number(peer),
        message: [{ type: "reply", data: { id: quoteID } }, { type: "text", data: { text } }],
      })
      if (response.kind === "not-sent") return { status: "unavailable" }
      if (response.kind !== "reply") return { status: "uncertain" }
      if (response.reply.status === "failed") return { status: "rejected" }
      if (response.reply.status !== "ok" || !record(response.reply.data)) return { status: "uncertain" }
      const messageID = numericID(response.reply.data.message_id)
      return messageID ? { status: "sent", messageID } : { status: "uncertain" }
    },
  }
}
