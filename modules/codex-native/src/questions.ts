import { randomUUID } from "node:crypto"
import type { ConversationBackend } from "../../../opencode/packages/schema/src/conversation-backend"
import type { CodexSessionAdapter } from "./session-adapter"
import type { UserInputRequest } from "./connection"

// Correlation for native pending requests only; no persisted answers, queue or automatic mode change.
export function nativeQuestions(adapter: CodexSessionAdapter, backendID: string) {
  const listeners = new Set<(event: ConversationBackend.Activity) => void>()
  const entries = new Map<string, { threadID: string; request: UserInputRequest; question: ConversationBackend.Question }>()
  let detach: (() => void) | undefined
  let epoch = 0
  const changed = (threadID: string) => {
    for (const listener of listeners) listener({ ref: { backendID, threadID }, change: "execution" })
  }
  const receive = (request: UserInputRequest, capture: number) => {
    const threadID = request.params.threadId
    if (typeof threadID !== "string") return
    void adapter.readOwned(threadID).then(() => {
      if (capture !== epoch || !listeners.size || adapter.userInput(request.id) !== request) return
      const question = parse(request)
      if (!question) { adapter.rejectUserInput(request.id); return }
      entries.set(question.id, { threadID, request, question })
      changed(threadID)
    }, () => undefined) // A foreign workspace may have its own input owner. Never decline on its behalf.
  }
  return {
    snapshot(threadID: string): ConversationBackend.Question[] {
      return [...entries.values()].filter((entry) => entry.threadID === threadID).map((entry) => ({
        ...entry.question, state: entry.request.responding ? "responding" : "pending",
      }))
    },
    async respond(threadID: string, questionID: string, answers?: Readonly<Record<string, readonly string[]>>): Promise<ConversationBackend.ControlResult> {
      const entry = entries.get(questionID)
      if (!entry || entry.threadID !== threadID || adapter.userInput(entry.request.id) !== entry.request) return { status: "not-found" }
      const reply = answers === undefined ? {} : validate(entry.question, answers)
      const result = adapter.answerUserInput(entry.request.id, reply)
      changed(threadID)
      return { status: await result }
    },
    subscribe(listener: (event: ConversationBackend.Activity) => void) {
      listeners.add(listener)
      if (!detach) {
        const capture = ++epoch
        const stop = adapter.subscribe(() => {
          for (const [id, entry] of entries) {
            if (adapter.userInput(entry.request.id) === entry.request) continue
            entries.delete(id)
            changed(entry.threadID)
          }
        })
        const close = adapter.onClose(() => { entries.clear() })
        const input = adapter.onUserInput((request) => receive(request, capture))
        detach = () => { input(); stop(); close() }
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size) return
        epoch++
        detach?.()
        detach = undefined
        entries.clear()
      }
    },
  }
}

function parse(request: UserInputRequest): ConversationBackend.Question | undefined {
  const params = request.params
  if (typeof params.turnId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(params.turnId) ||
      typeof params.itemId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(params.itemId) ||
      typeof params.isBlocking !== "boolean" || !Array.isArray(params.questions) || !params.questions.length) return
  const prompts: ConversationBackend.Question["prompts"][number][] = []
  for (const value of params.questions) {
    if (!record(value) || typeof value.id !== "string" || !value.id || prompts.some((prompt) => prompt.id === value.id) ||
        typeof value.header !== "string" || typeof value.question !== "string" || typeof value.isOther !== "boolean" ||
        value.isSecret !== false || !(value.options === null || Array.isArray(value.options))) return
    const options: { label: string; description: string }[] = []
    for (const option of value.options ?? []) {
      if (!record(option) || typeof option.label !== "string" || !option.label.trim() || typeof option.description !== "string" ||
          options.some((existing) => existing.label === option.label)) return
      options.push({ label: option.label, description: option.description })
    }
    if (!value.isOther && !options.length) return
    prompts.push({ id: value.id, header: value.header, question: value.question, other: value.isOther, options })
  }
  return { id: randomUUID(), turnID: params.turnId, itemID: params.itemId, blocking: params.isBlocking, state: "pending", prompts }
}

function validate(question: ConversationBackend.Question, answers: Readonly<Record<string, readonly string[]>>) {
  if (Object.keys(answers).length !== question.prompts.length) throw new Error("Invalid human input")
  const result: Record<string, { answers: readonly string[] }> = Object.create(null)
  for (const prompt of question.prompts) {
    const answer = Object.hasOwn(answers, prompt.id) ? answers[prompt.id] : undefined
    if (!Array.isArray(answer) || answer.length !== 1 || typeof answer[0] !== "string" || !answer[0].trim() ||
        (!prompt.other && !prompt.options.some((option) => option.label === answer[0]))) throw new Error("Invalid human input")
    result[prompt.id] = { answers: [...answer] }
  }
  return result
}

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) }
