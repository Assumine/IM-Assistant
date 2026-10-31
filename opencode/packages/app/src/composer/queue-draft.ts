import { Schema } from "effect"
import { Persistence } from "@/runtime/persistence/schema"
import { ComposerStore, type Prompt } from "./schema"
import type { ComposerStateTarget } from "./submission-state"
import { appendPrompt, clonePrompt, isAttachment, promptLength } from "./prompt-parts"

// The same editor stash for Session and whole-backend queue edits. This contains no executable work.
export const QueueDraft = Persistence.struct({
  prompt: ComposerStore.fields.prompt,
  cursor: Schema.Number,
  mode: Schema.Literals(["normal", "shell"]),
  retry: ComposerStore.fields.retry,
})

export type QueueDraft = typeof QueueDraft.Type

export function captureQueueDraft(draft: ComposerStateTarget): QueueDraft {
  return {
    prompt: clonePrompt(draft.current()),
    cursor: draft.cursor() ?? promptLength(draft.current()),
    mode: draft.mode.current(),
    retry: draft.retry.current(),
  }
}

export function restoreQueueDraft(draft: ComposerStateTarget, stash: QueueDraft) {
  // Both mode and prompt writes clear retry, so restore it last.
  draft.mode.set(stash.mode)
  draft.set(stash.prompt, stash.cursor)

  if (stash.retry) draft.retry.set(stash.retry)
}

export function mergeQueuePrompt(draft: Prompt, prompt: Prompt) {
  if (!promptLength(draft)) return [...prompt, ...draft.filter(isAttachment)]

  if (promptLength(prompt)) return appendPrompt(draft, prompt)

  return [...clonePrompt(draft), ...prompt.filter(isAttachment)]
}
