import { createKeyed, usePlugin, type ApplicationPage, type ServerRef } from "@opencode/plugin/gui"
import { Capability } from "@opencode/schema/capability"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { Loader } from "@opencode/ui/loader"
import { For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type definition from "./index"
import ModuleView from "./view"
import Settings from "./settings"

export type WorkspaceCatalog = {
  modules: readonly Capability.Info[]
  phase: "loading" | "ready" | "failed" | "offline"
}

export default function Workspace(props: {
  data: WorkspaceCatalog
  server?: ServerRef
  moduleID?: string
  title?: string
  label: (item: Capability.Info) => string
  icon: (item: Capability.Info) => NonNullable<ApplicationPage["icon"]>
}) {
  const ctx = usePlugin<typeof definition>()
  const module = () => props.data.modules.find((item) => item.id === props.moduleID)

  const configure = (item: Capability.Info) =>
    ctx.dialogs.open(() => (
      <ctx.ui.Dialog title={item.title}>
        <Settings id={item.id} server={props.server} />
      </ctx.ui.Dialog>
    ))

  return (
    <div class="assistant-workspace">
      <header class="assistant-workspace-header">
        <h1 class="text-20-medium">{props.title ?? ctx.t("workspace.title")}</h1>
        <Show
          when={module()}
          fallback={
            <a class="text-13-medium" href="/conversations">
              {ctx.t("workspace.conversations")}
            </a>
          }
        >
          {(item) => (
            <div class="flex items-center gap-3">
              <span role="status" class="text-13-regular text-v2-text-text-muted">
                {ctx.t(`state.${item().state}`)}
              </span>
              <Show when={item().settings}>
                <Button variant="ghost" size="small" onClick={() => configure(item())}>
                  {ctx.t("settings")}
                </Button>
              </Show>
            </div>
          )}
        </Show>
      </header>
      <Show
        when={props.data.phase !== "loading"}
        fallback={
          <div class="flex gap-2" role="status">
            <Loader />
            {ctx.t("loading")}
          </div>
        }
      >
        <Show
          when={props.data.phase === "ready"}
          fallback={<p role="status">{ctx.t(props.data.phase === "offline" ? "offline" : "failed")}</p>}
        >
          <Show
            when={props.moduleID}
            fallback={
              <div class="assistant-overview-grid">
                <section aria-label={ctx.t("workspace.services")}>
                  <h2 class="text-16-medium mb-4">{ctx.t("workspace.services")}</h2>
                  <For each={props.data.modules} fallback={<p>{ctx.t("empty")}</p>}>
                    {(item) => (
                      <button class="assistant-service-row" onClick={() => ctx.layout.page("module-" + item.id)}>
                        <Icon name={props.icon(item)} size="large" />
                        <span class="min-w-0 flex-1 text-left">
                          <span class="block text-14-medium truncate">{props.label(item)}</span>
                          <Show when={item.health?.message}>
                            <span class="block text-13-regular text-v2-text-text-muted truncate">
                              {item.health?.message}
                            </span>
                          </Show>
                        </span>
                        <span class="text-13-regular text-v2-text-text-muted">{ctx.t(`state.${item.state}`)}</span>
                        <Icon name="chevron-right" />
                      </button>
                    )}
                  </For>
                </section>
                <Attention server={props.server} />
              </div>
            }
          >
            <Show when={module()} fallback={<p role="status">{ctx.t("view.unavailable")}</p>}>
              {(item) => (
                <>
                  <Show when={item().health?.message}>
                    <p class="text-13-regular text-v2-text-text-muted mb-4">{item().health?.message}</p>
                  </Show>
                  <Show
                    when={item().state === "active" && item().view}
                    fallback={
                      <div class="assistant-workspace-empty">
                        <p>{ctx.t(item().state === "active" ? "view.unsupported" : "view.unavailable")}</p>
                        <Show when={item().settings}>
                          <Button variant="outline" onClick={() => configure(item())}>
                            {ctx.t("settings")}
                          </Button>
                        </Show>
                      </div>
                    }
                  >
                    <ModuleView id={item().id} server={props.server} parentTitle={props.title} />
                  </Show>
                </>
              )}
            </Show>
          </Show>
        </Show>
      </Show>
    </div>
  )
}

function Attention(props: { server?: ServerRef }) {
  const ctx = usePlugin<typeof definition>()

  const [state, setState] = createStore<{ items: readonly Capability.Notice[]; phase: "loading" | "ready" | "failed" }>(
    { items: [], phase: "loading" },
  )

  createKeyed(
    () => (props.server?.connected && props.server.compatible ? props.server.client : undefined),
    (client) => {
      const controller = new AbortController()
      const rpc = client.rpc(Capability.Api)
      let revision = 0

      const read = async () => {
        const current = ++revision

        try {
          const result = await rpc.notifications({ filter: "attention", limit: 5 }, { signal: controller.signal })

          if (!controller.signal.aborted && current === revision) setState({ items: result.items, phase: "ready" })
        } catch {
          if (!controller.signal.aborted && current === revision) setState("phase", "failed")
        }
      }

      onCleanup(() => controller.abort())
      onCleanup(rpc.events.on("changed", () => void read(), { signal: controller.signal }))
      void read()
    },
    { otherwise: () => setState("phase", "failed") },
  )

  return (
    <section aria-label={ctx.t("attention")}>
      <div class="flex justify-between items-center gap-3 mb-4">
        <h2 class="text-16-medium">{ctx.t("attention")}</h2>
        <Button size="small" variant="ghost" onClick={() => ctx.layout.page("messages")}>
          {ctx.t("workspace.allMessages")}
        </Button>
      </div>
      <Show
        when={state.phase === "ready"}
        fallback={<p role="status">{ctx.t(state.phase === "loading" ? "loading" : "failed")}</p>}
      >
        <For
          each={state.items}
          fallback={<p class="text-13-regular text-v2-text-text-muted">{ctx.t("workspace.noAttention")}</p>}
        >
          {(notice) => (
            <button class="assistant-service-row text-left" onClick={() => ctx.layout.page("messages")}>
              <span class="min-w-0">
                <span class="block text-14-medium">{notice.title}</span>
                <span class="block text-13-regular text-v2-text-text-muted line-clamp-2">{notice.message}</span>
              </span>
            </button>
          )}
        </For>
      </Show>
    </section>
  )
}
