import { For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { createKeyed, usePlugin } from "@opencode/plugin/gui"
import { ConversationBackend } from "@opencode/schema/conversation-backend"
import { Button } from "@opencode/ui/button"
import { Loader } from "@opencode/ui/loader"
import type definition from "./index"
import { ConversationBrowser } from "./browser"

/** A demand-loaded directory beside the native Home list; the backend still owns every thread. */
export default function HomeBackends(props: { server: string }) {
  const ctx = usePlugin<typeof definition>()

  const [state, setState] = createStore<{
    opened: boolean
    phase: "loading" | "ready" | "offline" | "error"
    items: readonly ConversationBackend.Descriptor[]
    selected?: string
    label?: string
  }>({ opened: false, phase: "loading", items: [] })

  const server = () => ctx.servers.get(props.server)

  const selected = () =>
    state.phase !== "offline" ? state.items.find((item) => item.id === state.selected && item.browse) : undefined

  let refresh = () => {}

  // The expanded Home section owns this directory subscription. Collapsing or leaving stops its reads.
  createKeyed(
    () => {
      const current = server()

      return state.opened && current?.connected && current.compatible ? current.client : undefined
    },
    (client) => {
      const lifetime = new AbortController()
      const options = { signal: lifetime.signal }
      const rpc = client.rpc(ConversationBackend.Api)
      let serial = 0
      onCleanup(() => lifetime.abort())
      refresh = () => {
        const revision = ++serial
        setState("phase", "loading")
        void rpc.list({}, options).then(
          (items) => {
            if (!lifetime.signal.aborted && revision === serial) setState({ items, phase: "ready" })
          },
          () => {
            if (!lifetime.signal.aborted && revision === serial) setState("phase", "error")
          },
        )
      }

      onCleanup(rpc.events.on("changed", refresh, options))
      refresh()
    },
    { otherwise: () => setState("phase", "offline") },
  )

  return (
    <section aria-label={ctx.t("home.title")} class="py-2 pr-3">
      <Button
        variant="ghost"
        size="small"
        aria-expanded={state.opened}
        onClick={() => setState("opened", !state.opened)}
      >
        {ctx.t("home.title")}
      </Button>
      <Show when={state.opened}>
        <div class="flex flex-col gap-3 py-3">
          <div class="flex flex-wrap items-center gap-2">
            <For each={state.items.filter((item) => item.browse)}>
              {(item) => (
                <Button
                  size="small"
                  variant={state.selected === item.id ? "neutral" : "ghost"}
                  aria-pressed={state.selected === item.id}
                  disabled={state.phase !== "ready"}
                  onClick={() => setState({ selected: item.id, label: item.label })}
                >
                  {item.label}
                </Button>
              )}
            </For>
            <Button
              size="small"
              variant="ghost"
              disabled={!server()?.connected || state.phase === "loading"}
              onClick={() => refresh()}
            >
              {ctx.t("refresh")}
            </Button>
          </div>
          <Show when={state.phase === "loading"}>
            <p role="status" class="flex items-center gap-2 text-13-regular">
              <Loader />
              {ctx.t("loading")}
            </p>
          </Show>
          <Show when={state.phase === "error"}>
            <p role="alert">{ctx.t("failed")}</p>
          </Show>
          <Show when={state.phase === "offline"}>
            <p role="status">{ctx.t("unavailable")}</p>
          </Show>
          <Show when={state.phase === "ready" && !state.items.some((item) => item.browse)}>
            <p role="status">{ctx.t("empty")}</p>
          </Show>
          <Show when={state.selected} keyed>
            {(id) => (
              <section
                aria-label={selected()?.label ?? state.label ?? id}
                class="overflow-hidden rounded-lg border border-v2-border-border-muted"
              >
                <Show
                  when={selected()}
                  fallback={
                    state.phase === "ready" ? (
                      <p role="status" class="p-3">
                        {ctx.t("unavailable")}
                      </p>
                    ) : undefined
                  }
                >
                  {(backend) => (
                    <ConversationBrowser
                      server={server}
                      backend={backend()}
                      listOnly
                      onOpen={(thread) =>
                        ctx.tabs.openBackend(
                          { server: props.server, ref: thread.ref, title: thread.title },
                          { focus: true },
                        )
                      }
                    />
                  )}
                </Show>
              </section>
            )}
          </Show>
        </div>
      </Show>
    </section>
  )
}
