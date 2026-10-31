import { onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { UiBackendComposerProps } from "@opencode/plugin/gui"
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
import { clonePrompt } from "./prompt-parts"
import { createComposerEditor } from "./editor/interaction"
import { ComposerEditor } from "./editor/editor"

// One unconfirmed handoff, not pending executable work. Native admission and its queue remain authoritative.
const BackendDraft = Persistence.struct({
  ...ComposerStore.fields,
  handoff: Persistence.optional(ConversationBackend.Input),
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
  const [state, setState] = createStore({ sending: false })
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

  const submit = () => {
    if (!ready() || !props.available || state.sending || store.handoff || lifetime.closed) return
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
        available: () => ready() && props.available && !state.sending && !store.handoff,
        stopping: () => false,
        held: () => state.sending,
        onSubmit: submit,
        onStop: () => {},
      },
    },
  })

  return (
    <section class="flex shrink-0 flex-col gap-2 px-5 py-3" aria-label={language.t("backend.composer.title")}>
      <Show
        when={ready()}
        fallback={
          <div role="status" class="flex h-24 items-center gap-2 text-13-regular text-v2-text-text-muted">
            <Loader />
            {language.t("backend.composer.loading")}
          </div>
        }
      >
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
