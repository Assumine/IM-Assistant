import type { ServerWebSocket } from "bun"

export type Call = { action: string; params: Record<string, unknown>; echo: string }
export function fakeOneBot(options: {
  botID?: string; token?: string; online?: boolean; early?: unknown
  call?: (socket: ServerWebSocket<undefined>, call: Call) => boolean | void
  redirect?: string
} = {}) {
  const token = options.token ?? "fixture-access-token"
  const calls: Call[] = [], sockets = new Set<ServerWebSocket<undefined>>(), upgrades: { header: string | null; url: string }[] = []
  const answers: { echo: string; status: string; data: unknown }[] = []
  let outgoing = -500
  const answer = (socket: ServerWebSocket<undefined>, call: Call, data: unknown, status = "ok", retcode = 0) => {
    answers.push({ echo: call.echo, status, data })
    return socket.send(JSON.stringify({ status, retcode, data, echo: call.echo }))
  }
  const server = Bun.serve<undefined>({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) {
      upgrades.push({ header: request.headers.get("authorization"), url: request.url })
      if (options.redirect) return new Response(null, { status: 302, headers: { location: options.redirect } })
      if (request.headers.get("authorization") !== "Bearer " + token) return new Response(null, { status: 403 })
      return server.upgrade(request) ? undefined : new Response(null, { status: 400 })
    },
    websocket: {
      open(socket) { sockets.add(socket); if (options.early) socket.send(JSON.stringify(options.early)) },
      close(socket) { sockets.delete(socket) },
      message(socket, body) {
        const value: Call = JSON.parse(String(body))
        calls.push(value)
        if (options.call?.(socket, value)) return
        if (value.action === "get_login_info") answer(socket, value, { user_id: options.botID ?? "10001", nickname: "Fixture" })
        else if (value.action === "get_status") answer(socket, value, { online: options.online ?? true, good: options.online ?? true })
        else if (["send_private_msg", "send_group_msg"].includes(value.action)) answer(socket, value, { message_id: outgoing-- })
        else answer(socket, value, null, "failed", 1404)
      },
    },
  })
  return {
    token, calls, sockets, upgrades, answer, answers, url: "ws://127.0.0.1:" + server.port + "/",
    event(value: unknown) { for (const socket of sockets) socket.send(JSON.stringify(value)) },
    frame(value: string | Buffer) { for (const socket of sockets) socket.send(value) },
    close() { server.stop(true) },
  }
}
export async function until(check: () => boolean | Promise<boolean>, timeout = 2000) {
  const deadline = Date.now() + timeout
  while (!await check()) {
    if (Date.now() > deadline) throw new Error("OneBot fixture deadline")
    await Bun.sleep(5)
  }
}
