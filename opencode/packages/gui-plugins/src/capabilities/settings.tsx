import { Show, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { createKeyed, usePlugin, type ServerRef } from "@opencode/plugin/gui"
import { Capability } from "@opencode/schema/capability"
import { Button } from "@opencode/ui/button"
import { Loader } from "@opencode/ui/loader"
import type definition from "./index"

export default function Settings(props: { id: string; server: ServerRef | undefined }) {
  const ctx = usePlugin<typeof definition>()

  const [state, setState] = createStore<{
    document?: Capability.Settings
    text: string
    phase: "loading" | "ready" | "offline" | "error"
    saving: boolean
    saved: boolean
    failed: boolean
  }>({ text: "", phase: "loading", saving: false, saved: false, failed: false })

  let reload = () => {}

  let save = () => {}

  // Bind user actions to the current authenticated server generation; do not poll or overwrite edits on reconnect.
  createKeyed(
    () => (props.server?.connected && props.server.compatible ? props.server.client : undefined),
    (client) => {
      const controller = new AbortController()
      const options = { signal: controller.signal }
      const rpc = client.rpc(Capability.Api)

      reload = () => {
        if (state.saving) return
        setState({ phase: "loading", saved: false, failed: false })
        void rpc.settings({ id: props.id }, options).then(
          (document) => {
            if (!controller.signal.aborted) setState({ document, text: document.text, phase: "ready" })
          },
          () => {
            if (!controller.signal.aborted) setState("phase", "error")
          },
        )
      }

      save = () => {
        if (state.phase !== "ready" || state.saving || !state.document) return
        setState({ saving: true, saved: false, failed: false })
        void rpc.configure({ id: props.id, revision: state.document.revision, text: state.text }, options).then(
          (document) => {
            if (!controller.signal.aborted) setState({ document, text: document.text, saving: false, saved: true })
          },
          () => {
            if (!controller.signal.aborted) setState({ saving: false, failed: true })
          },
        )
      }

      onCleanup(() => controller.abort())

      if (!state.document) reload()
      else setState({ phase: "ready", saving: false })
    },
    { otherwise: () => setState({ phase: "offline", saving: false }) },
  )

  return (
    <div class="px-5 pb-5 flex flex-col gap-3">
      <p class="text-13-regular text-v2-text-text-muted">{ctx.t("settingsDescription")}</p>
      <Show when={state.document?.description}>
        {(description) => <p class="text-13-regular text-v2-text-text-muted">{description()}</p>}
      </Show>
      <Show when={state.phase === "loading"}>
        <span role="status" class="flex items-center gap-2 text-13-regular">
          <Loader />
          {ctx.t("loading")}
        </span>
      </Show>
      <Show when={state.phase === "offline" || state.phase === "error"}>
        <p role="alert">{ctx.t(state.phase === "offline" ? "offline" : "settingsFailed")}</p>
      </Show>
      <label class="flex flex-col gap-2 text-13-regular">
        {ctx.t("settingsDocument")}
        <textarea
          aria-label={ctx.t("settingsDocument")}
          class="w-full min-h-80 max-h-[55vh] overflow-y-auto resize-y rounded-md border border-v2-border-border-base bg-v2-surface-base p-3 font-mono text-13-regular"
          data-scrollable
          spellcheck={false}
          value={state.text}
          disabled={state.phase !== "ready" || state.saving}
          onInput={(event) => setState({ text: event.currentTarget.value, saved: false })}
        />
      </label>
      <Show when={state.failed}>
        <p role="alert" class="text-13-regular">{ctx.t("settingsFailed")}</p>
      </Show>
      <Show when={state.saved}>
        <p role="status" class="text-13-regular">{ctx.t("settingsSaved")}</p>
      </Show>
      <div class="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => reload()} disabled={state.phase === "offline" || state.saving}>
          {ctx.t("settingsReload")}
        </Button>
        <Button onClick={() => save()} disabled={state.phase !== "ready" || state.saving || state.text === state.document?.text}>
          {ctx.t(state.saving ? "settingsSaving" : "settingsSave")}
        </Button>
      </div>
    </div>
  )
}
