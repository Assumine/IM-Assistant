import type { Page } from "@playwright/test"
import { Schema } from "effect"
import { ConversationBackend } from "@opencode/schema/conversation-backend"

// Reads committed inline prompt text so reload tests do not race the draft writer.
async function readDraftDocument(page: Page, suffix: string) {
  return page.evaluate(async (suffix) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("opencode-drafts", 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })

    try {
      const transaction = db.transaction("documents", "readonly")
      const documents = transaction.objectStore("documents")

      const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
        const request = documents.getAllKeys()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })

      const key = keys.find((key) => String(key).endsWith(suffix))

      if (key === undefined) return null

      return await new Promise<unknown>((resolve, reject) => {
        const request = documents.get(key)
        transaction.oncomplete = () => resolve(request.result)
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      })
    } finally {
      db.close()
    }
  }, suffix)
}

export async function readSessionDraftText(page: Page, sessionID: string) {
  const raw = await readDraftDocument(page, `:session:${sessionID}:prompt`)

  if (raw === null) return ""

  const draft = Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Struct({
        prompt: Schema.Array(Schema.Struct({ type: Schema.String, content: Schema.optional(Schema.Unknown) })),
      }),
    ),
  )(raw)

  return draft.prompt
    .filter((part) => part.type === "text")
    .map((part) => Schema.decodeUnknownSync(Schema.String)(part.content))
    .join("")
}

export async function readBackendDraft(page: Page, server: string, ref: ConversationBackend.Ref) {
  const raw = await readDraftDocument(
    page,
    `:backend-composer:${JSON.stringify([server, ref.backendID, ref.threadID])}`,
  )

  if (raw === null) return null

  const draft = Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Struct({
        prompt: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), content: Schema.String })),
        handoff: Schema.optional(Schema.NullOr(ConversationBackend.Input)),
        editing: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              nativeID: Schema.String,
              unconfirmed: Schema.optional(Schema.NullOr(Schema.Boolean)),
              stash: Schema.Struct({
                prompt: Schema.Array(Schema.Struct({ type: Schema.String, content: Schema.String })),
              }),
            }),
          ),
        ),
        withdrawal: Schema.optional(Schema.NullOr(Schema.Struct({ nativeID: Schema.String, text: Schema.String }))),
      }),
    ),
  )(raw)

  return {
    text: draft.prompt.map((part) => part.content).join(""),
    handoff: draft.handoff ?? undefined,
    editing: draft.editing ?? undefined,
    withdrawal: draft.withdrawal ?? undefined,
  }
}
