import { onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { UiBackendComposerProps, UiQueueView } from "@opencode/plugin/gui"
import { Schema } from "effect"
import { ConversationBackend } from "@opencode/schema/conversation-backend"
import { uuid } from "@opencode/util/uuid"
import { Loader } from "@opencode/ui/loader"
import { Button } from "@opencode/ui/button"
import { Persistence } from "@/runtime/persistence/schema"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { useLanguage } from "@/runtime/i18n/language"
import { ComposerStore } from "./schema"
import { initialComposerStore, createComposerStateValue } from "./state"
import { createComposerSubmission } from "./submission-state"
import { clonePrompt, promptLength } from "./prompt-parts"
import { QueueDraft, captureQueueDraft, restoreQueueDraft, mergeQueuePrompt } from "./queue-draft"
import { SessionQueuePanel } from "@/session/composer/queue-panel"
import { createComposerEditor } from "./editor/interaction"
import { ComposerEditor } from "./editor/editor"

// One unconfirmed handoff, not pending executable work. Native admission and its queue remain authoritative.
const BackendDraft = Persistence.struct({
  ...ComposerStore.fields,
  handoff: Persistence.optional(ConversationBackend.Input),
  editing: Persistence.optional(
    Persistence.struct({
      nativeID: Schema.String,
      stash: QueueDraft,
      unconfirmed: Persistence.optional(Schema.Boolean),
    }),
  ),
  withdrawal: Persistence.optional(Persistence.struct({ nativeID: Schema.String, text: Schema.String })),
})

export default function BackendComposer(props: UiBackendComposerProps) {
  const language = useLanguage()
  const key = JSON.stringify([props.server, props.threadRef.backendID, props.threadRef.threadID])

  const [store, setStore, , ready] = persisted(
    Persist.prompt(Persist.global(`backend-composer:${key}`)),
    BackendDraft,
    initialComposerStore(),
  )

  const draft = createComposerStateValue(store, setStore)

  const [state, setState] = createStore<{
    sending: boolean
    changing: boolean
    notice?: "editMissing" | "withdrawMissing" | "partialInput"
  }>({ sending: false, changing: false })

  const lifetime = { closed: false }
  onCleanup(() => {
    lifetime.closed = true
  })

  const deliver = async () => {
    const input = store.handoff

    if (!ready() || !props.available || state.sending || !input || lifetime.closed) return
    setState("sending", true)
    // Unlike a read, admission must finish if the user navigates away. Native work is not tied to this view.
    const admission = await props.send(input).catch(() => undefined)

    if (lifetime.closed) return
    setState("sending", false)

    if (admission?.status !== "accepted") return
    setStore("handoff", undefined)
    props.onAccepted?.(admission)
  }

  const observed = () => {
    const value = props.execution

    if (
      value?.thread.ref.backendID !== props.threadRef.backendID ||
      value.thread.ref.threadID !== props.threadRef.threadID
    )
      return

    return value
  }

  const blocked = () =>
    !ready() || !props.available || props.busy || state.changing || lifetime.closed || !observed() || !props.control

  const textOf = () =>
    draft
      .current()
      .flatMap((part) => (part.type === "text" ? [part.content] : []))
      .join("")

  const cancelEdit = () => {
    const editing = store.editing

    if (!editing || state.changing) return
    restoreQueueDraft(draft, editing.stash)
    setStore("editing", undefined)
    setState("notice", undefined)
    editor.restoreFocus(editing.stash.cursor)
  }

  const edit = (nativeID: string) => {
    if (blocked() || store.handoff || store.withdrawal) return false

    if (store.editing?.nativeID === nativeID) return true
    const item = observed()?.queue.find((entry) => entry.nativeID === nativeID)

    if (!item) return false

    if (item.partial) {
      setState("notice", "partialInput")

      return false
    }

    if (store.editing) cancelEdit()
    setStore("editing", { nativeID, stash: captureQueueDraft(draft) })
    draft.set([{ type: "text", content: item.text, start: 0, end: item.text.length }], item.text.length)
    setState("notice", undefined)
    editor.restoreFocus(item.text.length)

    return true
  }

  const saveEdit = async () => {
    const editing = store.editing
    const control = props.control
    const text = textOf()

    if (!editing || editing.unconfirmed || blocked() || !control || !text.trim()) return

    if (!observed()?.queue.some((entry) => entry.nativeID === editing.nativeID)) {
      setState("notice", "editMissing")

      return
    }

    // Persist the edit identity before dispatch. Reload never interprets this text as a new input or auto-retries it.
    setStore("editing", "unconfirmed", true)
    setState("changing", true)

    const result = await control({
      action: "update",
      threadID: props.threadRef.threadID,
      nativeID: editing.nativeID,
      text,
    }).catch(() => undefined)

    if (lifetime.closed) return
    setState("changing", false)

    if (!result) return
    setStore("editing", "unconfirmed", undefined)

    if (result.status !== "applied") {
      setState("notice", "editMissing")

      return
    }

    // Typing during a save belongs to a newer edit. Only restore the stashed draft if the submitted text is unchanged.
    if (textOf() === text) cancelEdit()
  }

  const undo = async (nativeID: string) => {
    const control = props.control

    if (queue.busy() || !control) return
    const item = observed()?.queue.find((entry) => entry.nativeID === nativeID)

    if (!item) return

    if (item.partial) {
      setState("notice", "partialInput")

      return
    }

    setStore("withdrawal", { nativeID, text: item.text })
    setState("changing", true)

    const result = await control({ action: "withdraw", threadID: props.threadRef.threadID, nativeID }).catch(
      () => undefined,
    )

    if (lifetime.closed) return
    setState("changing", false)

    // Unknown withdrawal retains its source text for inspection, but absence from the queue is not proof of deletion.
    if (!result) return
    setStore("withdrawal", undefined)

    if (result.status !== "applied") {
      setState("notice", "withdrawMissing")

      return
    }

    const merged = mergeQueuePrompt(draft.current(), [
      { type: "text", content: item.text, start: 0, end: item.text.length },
    ])

    draft.set(merged, promptLength(merged))
    editor.restoreFocus(promptLength(merged))
  }

  const queue: UiQueueView = {
    rows: () => observed()?.queue.map((item) => ({ id: item.nativeID, text: item.text, attachments: 0 })) ?? [],
    editing: () => store.editing?.nativeID,
    working: () => observed()?.thread.state === "running",
    busy: () => blocked() || !!store.editing || !!store.withdrawal || !!store.handoff,
    get edit() {
      return props.control ? edit : undefined
    },
    get undo() {
      return props.control ? (nativeID: string) => void undo(nativeID) : undefined
    },
    get steer() {
      if (!props.control || observed()?.thread.state !== "running" || observed()?.turn?.state !== "running") return

      return (nativeID: string) =>
        void props.control?.({ action: "guide", threadID: props.threadRef.threadID, nativeID }).catch(() => undefined)
    },
    get remove() {
      if (!props.control) return

      return (nativeID: string) =>
        void props
          .control?.({ action: "withdraw", threadID: props.threadRef.threadID, nativeID })
          .catch(() => undefined)
    },
    get reorder() {
      if (!props.control || observed()?.nextCursor) return

      return (nativeIDs: string[]) =>
        void props
          .control?.({ action: "reorder", threadID: props.threadRef.threadID, nativeIDs })
          .catch(() => undefined)
    },
  }

  const submit = () => {
    if (store.editing) {
      void saveEdit()

      return
    }

    if (!ready() || !props.available || state.sending || store.handoff || store.withdrawal || lifetime.closed) return
    const prompt = clonePrompt(draft.current())
    const text = prompt.flatMap((part) => (part.type === "text" ? [part.content] : [])).join("")

    if (!text.trim()) return
    const submission = createComposerSubmission({ target: draft, prompt, context: [] })
    setStore("handoff", { ref: props.threadRef, inputID: uuid(), text, delivery: "queue" })
    // Capture before clearing. Later typing belongs to the next draft and is never cleared by an old reply.
    submission.clear()
    void deliver()
  }

  const editor = createComposerEditor({
    store: draft.store,
    textOnly: true,
    shellEnabled: false,
    commands: () => [],
    context: () => [],
    searchContextFiles: () => [],
    view: {
      placeholder: () => language.t("backend.composer.placeholder"),
      submit: {
        label: () => (store.editing ? language.t("backend.composer.saveEdit") : undefined),
        available: () =>
          ready() &&
          props.available &&
          !state.sending &&
          !store.handoff &&
          !store.withdrawal &&
          (!store.editing || (!blocked() && !store.editing.unconfirmed)),
        stopping: () => false,
        held: () => state.sending || state.changing,
        onSubmit: submit,
        onStop: () => {},
      },
    },
  })

  return (
    <section
      class="flex shrink-0 flex-col gap-2 px-5 py-3"
      aria-label={language.t("backend.composer.title")}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented || !store.editing) return
        event.preventDefault()
        cancelEdit()
      }}
    >
      <Show
        when={ready()}
        fallback={
          <div role="status" class="flex h-24 items-center gap-2 text-13-regular text-v2-text-text-muted">
            <Loader />
            {language.t("backend.composer.loading")}
          </div>
        }
      >
        <SessionQueuePanel queue={queue} attached={false} />
        <Show when={state.notice}>
          {(notice) => (
            <p role="alert" class="text-13-regular">
              {language.t(`backend.composer.${notice()}`)}
            </p>
          )}
        </Show>
        <Show when={store.editing}>
          {(editing) => (
            <div class="flex items-center gap-2 text-13-regular">
              <span class="flex-1">
                {language.t(
                  editing().unconfirmed && !state.changing
                    ? "backend.composer.editUnknown"
                    : "backend.composer.editing",
                )}
              </span>
              <Button size="small" variant="ghost" disabled={state.changing} onClick={cancelEdit}>
                {language.t("backend.composer.cancelEdit")}
              </Button>
            </div>
          )}
        </Show>
        <Show when={store.withdrawal}>
          {(withdrawal) => (
            <div role="status" class="flex flex-col gap-2 text-13-regular">
              <p>{language.t(state.changing ? "backend.composer.withdrawing" : "backend.composer.withdrawUnknown")}</p>
              <p class="max-h-24 overflow-y-auto whitespace-pre-wrap" data-scrollable>
                {withdrawal().text}
              </p>
              <Button
                size="small"
                variant="ghost"
                disabled={state.changing}
                onClick={() => setStore("withdrawal", undefined)}
              >
                {language.t("backend.composer.dismissWithdrawal")}
              </Button>
            </div>
          )}
        </Show>
        <Show when={store.handoff}>
          {(input) => (
            <div role="status" class="flex min-w-0 items-center gap-2 text-13-regular">
              <Show when={state.sending}>
                <Loader />
              </Show>
              <div class="min-w-0 flex-1">
                <p>{language.t(state.sending ? "backend.composer.sending" : "backend.composer.unconfirmed")}</p>
                <p class="truncate text-v2-text-text-muted" title={input().text}>
                  {input().text}
                </p>
              </div>
              <Show when={!state.sending}>
                <Button variant="ghost" size="small" disabled={!props.available} onClick={() => void deliver()}>
                  {language.t("backend.composer.check")}
                </Button>
              </Show>
            </div>
          )}
        </Show>
        <ComposerEditor controller={editor} addMenu={false} modelControlsVisible={false} />
        <Show when={!props.available}>
          <p class="text-13-regular text-v2-text-text-muted">{language.t("backend.composer.unavailable")}</p>
        </Show>
      </Show>
    </section>
  )
}
