import type { FormAnswer, FormInfo } from "@opencode/client/promise"

/** Shared presentation for native forms and whole-backend questions; no Session identity or execution state. */
export interface QuestionDockProps {
  request: { id: string; fields: readonly FormInfo["fields"][number][] }
  cacheKey: string
  reply: (answer: FormAnswer) => Promise<void>
  reject: () => Promise<void>
  onSubmit: () => void
  disabled?: boolean
  requireAnswers?: boolean
  retainDraft?: () => boolean
}
