export interface Notification {
  method: string
  params: Record<string, unknown>
}
export interface UserInputRequest {
  id: number | string
  params: Record<string, unknown>
  responding: boolean
}
type UserInputReply = { answers: Record<string, { answers: readonly string[] }> }

export class NativeError extends Error {
  constructor(readonly code: number, message: string) {
    super(message)
    this.name = "NativeError"
  }
}
export class OutcomeUnknown extends Error {
  constructor(readonly method: string) {
    super(`${method}: native response unavailable; reconcile native state before retrying`)
    this.name = "OutcomeUnknown"
  }
}
export interface Wire {
  send: (text: string) => void
  close: () => Promise<void>
  listen: (message: (text: string) => void, closed: () => void) => void
}

// RPC correlation only. The wire owns its connection; Codex owns all execution.
export class Connection {
  private serial = 0
  private closed = false
  private pending = new Map<number, {
    method: string
    resolve: (value: unknown) => void
    reject: (reason: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  private listeners = new Set<(event: Notification) => void>()
  private closeListeners = new Set<() => void>()
  private runtime?: { mode: "stdio" | "shared"; pid: number }
  private inputListener?: (request: UserInputRequest) => void
  private inputs = new Map<string, {
    request: UserInputRequest
    finish?: () => void
    fail?: () => void
    timer?: ReturnType<typeof setTimeout>
  }>()

  constructor(private wire: Wire, private timeoutMs: number) {
    wire.listen((text) => {
      try { this.receive(JSON.parse(text)) } catch {
        this.fail()
        void wire.close()
      }
    }, () => this.fail())
  }

  setRuntime(mode: "stdio" | "shared", pid: number) { this.runtime = { mode, pid } }
  info() {
    if (!this.runtime) throw new Error("Native connection is not initialized")
    return { ...this.runtime }
  }
  subscribe(listener: (event: Notification) => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  onClose(listener: () => void) {
    if (this.closed) listener()
    else this.closeListeners.add(listener)
    return () => { this.closeListeners.delete(listener) }
  }
  onUserInput(listener: (request: UserInputRequest) => void) {
    if (this.inputListener) throw new Error("Native input owner already attached")
    this.inputListener = listener
    for (const { request } of this.inputs.values()) listener(request)
    return () => { if (this.inputListener === listener) this.inputListener = undefined }
  }
  userInput(id: number | string) { return this.inputs.get(JSON.stringify(id))?.request }
  answerUserInput(id: number | string, reply: UserInputReply): Promise<"resolved" | "not-found"> {
    const input = this.inputs.get(JSON.stringify(id))
    if (this.closed || !input) return Promise.resolve("not-found")
    if (input.request.responding) return Promise.reject(new OutcomeUnknown("item/tool/requestUserInput"))
    input.request.responding = true
    return new Promise((resolve, reject) => {
      input.finish = () => resolve("resolved")
      input.fail = () => reject(new OutcomeUnknown("item/tool/requestUserInput"))
      input.timer = setTimeout(() => { input.finish = undefined; input.fail?.(); input.fail = undefined }, this.timeoutMs)
      this.write({ id, result: reply })
    })
  }
  rejectUserInput(id: number | string) {
    const key = JSON.stringify(id)
    const input = this.inputs.get(key)
    if (!input || input.request.responding) return
    input.request.responding = true
    this.write({ id, error: { code: -32601, message: "Host capability unavailable" } })
  }
  request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (this.closed) return Promise.reject(new OutcomeUnknown(method))
    return new Promise((resolve, reject) => {
      const id = ++this.serial
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new OutcomeUnknown(method))
      }, this.timeoutMs)
      this.pending.set(id, { method, resolve: (value) => resolve(value as T), reject, timer })
      this.write({ id, method, params })
    })
  }
  write(message: object) {
    if (!this.closed) this.wire.send(JSON.stringify(message))
  }
  private receive(message: { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string } }) {
    if (message.method && message.id !== undefined) {
      if (message.method === "item/tool/requestUserInput") {
        const key = JSON.stringify(message.id)
        if (this.inputs.has(key)) return
        const request = { id: message.id, params: message.params ?? {}, responding: false }
        this.inputs.set(key, { request })
        // Native broadcasts to observers too. An observer must not auto-decline another client's question.
        try { this.inputListener?.(request) } catch { /* Only the input owner can answer; never approve another method. */ }
        return
      }
      this.write({ id: message.id, error: { code: -32601, message: "Host capability unavailable" } })
      return
    }
    if (message.id !== undefined) {
      const pending = typeof message.id === "number" ? this.pending.get(message.id) : undefined
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id as number)
      if (message.error) pending.reject(new NativeError(message.error.code, message.error.message))
      else pending.resolve(message.result)
      return
    }
    if (message.method) {
      if (message.method === "serverRequest/resolved" && (typeof message.params?.requestId === "string" || typeof message.params?.requestId === "number")) {
        const key = JSON.stringify(message.params.requestId)
        const input = this.inputs.get(key)
        if (input && input.request.params.threadId === message.params.threadId) {
          this.inputs.delete(key)
          clearTimeout(input.timer)
          input.finish?.()
        }
      }
      if (message.method === "turn/completed") {
        for (const [key, input] of this.inputs) {
          const turn = message.params?.turn
          if (input.request.params.threadId !== message.params?.threadId || !turn || typeof turn !== "object" || !("id" in turn) || turn.id !== input.request.params.turnId) continue
          this.inputs.delete(key)
          clearTimeout(input.timer)
          input.fail?.()
        }
      }
      for (const listener of this.listeners) {
        try { listener({ method: message.method, params: message.params ?? {} }) } catch { /* Observers do not own execution. */ }
      }
    }
  }
  private fail() {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new OutcomeUnknown(pending.method))
    }
    this.pending.clear()
    for (const input of this.inputs.values()) { clearTimeout(input.timer); input.fail?.() }
    this.inputs.clear()
    this.inputListener = undefined
    this.listeners.clear()
    for (const listener of this.closeListeners) {
      try { listener() } catch { /* Observers cannot stop cleanup. */ }
    }
    this.closeListeners.clear()
  }
  async close() {
    this.fail()
    await this.wire.close()
  }
}
