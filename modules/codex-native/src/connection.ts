export interface Notification {
  method: string
  params: Record<string, unknown>
}

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
