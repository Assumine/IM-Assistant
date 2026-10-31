import { For, Show, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { createKeyed, usePlugin } from "@opencode/plugin/gui"
import { ConversationBackend } from "@opencode/schema/conversation-backend"
import type definition from "./index"
import { ConversationBrowser } from "./browser"

/** Explicit native launch actions. Choosing or viewing a backend never sends the OpenCode draft. */
export default function Launcher(props: { server: string; close: () => void }) {
  const ctx = usePlugin<typeof definition>()

  const [state, setState] = createStore<{
    items: readonly ConversationBackend.Descriptor[]
    selected?: string
    phase: "loading" | "ready" | "offline" | "error"
    creating: boolean
    uncertain: string[]
    browsing?: ConversationBackend.Descriptor
  }>({ items: [], phase: "loading", creating: false, uncertain: [] })

  const server = () => ctx.servers.get(props.server)
  const selected = () => state.items.find((item) => item.id === state.selected)
  const available = () => state.phase === "ready" && !!selected() && server()?.connected
  let refresh = () => {}

  let create = () => {}

  let disposed = false
  onCleanup(() => {
    disposed = true
  })

  // Observe this dialog's server generation only. No polling, default backend switch or executable local queue.
  createKeyed(
    () => {
      const current = server()

      return current?.connected && current.compatible ? current.client : undefined
    },
    (client) => {
      const lifetime = new AbortController()
      const options = { signal: lifetime.signal }
      const rpc = client.rpc(ConversationBackend.Api)
      let serial = 0
      let creating: string | undefined
      onCleanup(() => {
        lifetime.abort()

        if (!disposed && creating) {
          const id = creating
          setState("uncertain", (items) => (items.includes(id) ? items : [...items, id]))
          setState("creating", false)
        }
      })
      const current = () => !disposed && !lifetime.signal.aborted && server()?.client === client

      const list = async () => {
        const revision = ++serial
        setState("phase", "loading")

        try {
          const items = await rpc.list({}, options)

          if (current() && revision === serial) setState({ items, phase: "ready" })
        } catch {
          if (current() && revision === serial) setState("phase", "error")
        }
      }

      refresh = () => {
        void list()
      }

      create = () => {
        const backend = selected()

        if (!current() || !available() || !backend?.create || state.creating || state.uncertain.includes(backend.id))
          return
        const id = backend.id
        creating = id
        setState("creating", true)
        // Native thread/start is not an idempotent write. Do not abort it on closing, or retry an unknown outcome.
        void rpc
          .create({ backendID: id })
          .then((created) => {
            if (!current()) return

            if (created.thread.ref.backendID !== id) throw new Error("Different backend")
            ctx.tabs.openBackend(
              { server: props.server, ref: created.thread.ref, title: created.thread.title },
              { focus: true },
            )
            props.close()
          })
          .catch(() => {
            if (current()) setState("uncertain", (items) => (items.includes(id) ? items : [...items, id]))
          })
          .finally(() => {
            if (!current()) return
            creating = undefined
            setState("creating", false)
          })
      }

      onCleanup(rpc.events.on("changed", refresh, options))
      refresh()
    },
    { otherwise: () => setState("phase", "offline") },
  )

  const browse = () => {
    const backend = selected()

    if (!available() || !backend?.browse || state.creating) return

    setState("browsing", backend)
  }

  return (
    <Show
      when={state.browsing}
      keyed
      fallback={
        <ctx.ui.Dialog title={ctx.t("launch.title")}>
          <div class="flex flex-col gap-4 py-4">
            <label class="flex items-center justify-between gap-4 text-13-regular">
              {ctx.t("launch.backend")}
              <select
                aria-label={ctx.t("launch.backend")}
                value={state.selected ?? ""}
                disabled={state.creating || state.phase !== "ready"}
                onChange={(event) => setState("selected", event.currentTarget.value || undefined)}
              >
                <option value="" selected={!state.selected}>
                  {ctx.t("launch.choose")}
                </option>
                <Show when={state.selected && !selected()}>
                  <option value={state.selected} selected disabled>
                    {state.selected}
                  </option>
                </Show>
                <For each={state.items}>
                  {(item) => (
                    <option value={item.id} selected={state.selected === item.id}>
                      {item.label}
                    </option>
                  )}
                </For>
              </select>
            </label>
            <Show when={state.phase === "loading"}>
              <div role="status" class="flex items-center gap-2">
                <ctx.ui.Loader />
                {ctx.t("loading")}
              </div>
            </Show>
            <Show when={state.phase === "error"}>
              <p role="alert">{ctx.t("failed")}</p>
            </Show>
            <Show when={state.phase === "offline" || (state.selected && !selected() && state.phase === "ready")}>
              <p role="status">{ctx.t("unavailable")}</p>
            </Show>
            <Show when={state.phase === "ready" && !state.items.length}>
              <p role="status">{ctx.t("empty")}</p>
            </Show>
            <Show when={state.selected && state.uncertain.includes(state.selected)}>
              <p role="alert">{ctx.t("launch.unknown")}</p>
            </Show>
            <div class="flex flex-wrap gap-2">
              <ctx.ui.Button
                variant="neutral"
                disabled={state.creating || state.phase === "loading" || !server()?.connected}
                onClick={() => refresh()}
              >
                {ctx.t("refresh")}
              </ctx.ui.Button>
              <Show when={selected()?.browse}>
                <ctx.ui.Button variant="neutral" disabled={!available() || state.creating} onClick={browse}>
                  {ctx.t("browse.open")}
                </ctx.ui.Button>
              </Show>
              <Show when={selected()?.create}>
                <ctx.ui.Button
                  disabled={
                    !available() || state.creating || !!(state.selected && state.uncertain.includes(state.selected))
                  }
                  busy={state.creating}
                  onClick={() => create()}
                >
                  {ctx.t("launch.create")}
                </ctx.ui.Button>
              </Show>
            </div>
          </div>
        </ctx.ui.Dialog>
      }
    >
      {(backend) => (
        <ConversationBrowser
          server={server}
          backend={backend}
          onOpen={(thread) => {
            if (disposed) return
            ctx.tabs.openBackend({ server: props.server, ref: thread.ref, title: thread.title }, { focus: true })
            props.close()
          }}
        />
      )}
    </Show>
  )
}
