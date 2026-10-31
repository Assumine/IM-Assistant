import { expect, test } from "bun:test"
import { Connection, OutcomeUnknown, type UserInputRequest } from "../src/connection"

function wire(timeoutMs = 1000) {
  const sent: Record<string, unknown>[] = []
  let receive!: (text: string) => void
  const connection = new Connection({
    send: (text) => { sent.push(JSON.parse(text)) },
    close: async () => {},
    listen: (listener) => { receive = listener },
  }, timeoutMs)
  return { connection, sent, emit: (message: object) => receive(JSON.stringify(message)) }
}
const request = { id: 0, method: "item/tool/requestUserInput", params: { threadId: "thread", turnId: "turn" } }

test("observers ignore human input, retain it for an owner and deny every other host capability", async () => {
  const native = wire()
  native.emit(request)
  expect(native.sent).toEqual([])
  const inputs: UserInputRequest[] = []
  const detach = native.connection.onUserInput((input) => inputs.push(input))
  native.emit(request)
  expect(inputs).toHaveLength(1)
  expect(() => native.connection.onUserInput(() => {})).toThrow("already attached")
  for (const method of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "item/tool/call", "unknown/host"]) {
    native.emit({ id: method, method, params: {} })
    expect(native.sent.at(-1)).toEqual({ id: method, error: { code: -32601, message: "Host capability unavailable" } })
  }
  detach()
  expect(native.connection.userInput(0)).toBe(inputs[0])
  await native.connection.close()
  expect(native.connection.userInput(0)).toBeUndefined()
})

test("answer dispatch is not resolution; only the matching native acknowledgement resolves it", async () => {
  const native = wire()
  native.emit(request)
  const result = native.connection.answerUserInput(0, { answers: { choice: { answers: ["Alpha"] } } })
  expect(native.sent).toEqual([{ id: 0, result: { answers: { choice: { answers: ["Alpha"] } } } }])
  expect(native.connection.userInput(0)?.responding).toBe(true)
  native.emit({ method: "serverRequest/resolved", params: { threadId: "other-thread", requestId: 0 } })
  native.emit({ method: "serverRequest/resolved", params: { threadId: "thread", requestId: "0" } })
  expect(native.connection.userInput(0)).toBeDefined()
  await expect(native.connection.answerUserInput(0, { answers: {} })).rejects.toBeInstanceOf(OutcomeUnknown)
  native.emit({ method: "serverRequest/resolved", params: { threadId: "thread", requestId: 0 } })
  expect(await result).toBe("resolved")
  expect(await native.connection.answerUserInput(0, { answers: {} })).toBe("not-found")
  await native.connection.close()
})

test("an unknown answer outcome cannot be blindly resent, and a later native resolution clears it", async () => {
  // Use the connection's real deadline option; no sleep or global timer patching across native subprocess tests.
  const native = wire(0)
  native.emit(request)
  const result = native.connection.answerUserInput(0, { answers: {} }).catch((error: unknown) => error)
  expect(await result).toBeInstanceOf(OutcomeUnknown)
  await expect(native.connection.answerUserInput(0, { answers: {} })).rejects.toBeInstanceOf(OutcomeUnknown)
  expect(native.sent).toHaveLength(1)
  native.emit({ method: "serverRequest/resolved", params: { threadId: "thread", requestId: 0 } })
  expect(native.connection.userInput(0)).toBeUndefined()
  await native.connection.close()
})

test("native turn completion and connection closure expire pending input without success or replay", async () => {
  const native = wire()
  native.emit(request)
  const result = native.connection.answerUserInput(0, { answers: {} }).catch((error: unknown) => error)
  native.emit({ method: "turn/completed", params: { threadId: "thread", turn: { id: "other-turn" } } })
  expect(native.connection.userInput(0)).toBeDefined()
  native.emit({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn" } } })
  expect(await result).toBeInstanceOf(OutcomeUnknown)
  expect(await native.connection.answerUserInput(0, { answers: {} })).toBe("not-found")
  native.emit({ ...request, id: "second" })
  const closing = native.connection.answerUserInput("second", { answers: {} }).catch((error: unknown) => error)
  await native.connection.close()
  expect(await closing).toBeInstanceOf(OutcomeUnknown)
  expect(native.connection.userInput("second")).toBeUndefined()
  expect(native.sent).toHaveLength(2)
})
