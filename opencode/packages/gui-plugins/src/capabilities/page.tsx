import { createMemo, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { createKeyed, usePlugin, type ServerRef } from "@opencode/plugin/gui"
import { Capability } from "@opencode/schema/capability"
import { Button } from "@opencode/ui/button"
import { Loader } from "@opencode/ui/loader"
import type definition from "./index"
import Monitor from "./monitor"
import Settings from "./settings"

type View = "modules" | "messages"

export default function Page(props: { view: View }) {
  const ctx = usePlugin<typeof definition>()
  const [state, setState] = createStore<{ server?: string }>({})
  const servers = createMemo(() => ctx.servers.list().flatMap((id) => ctx.servers.get(id) ?? []))
  const selected = () => state.server ?? servers().find((server) => server.builtin)?.id ?? servers()[0]?.id

  return (
    <>
      <div class="settings-tab-header">
        <div class="settings-tab-header-row">
          <div class="flex flex-col gap-1">
            <h2 class="settings-tab-title">{ctx.t(props.view)}</h2>
            <p class="text-13-regular text-v2-text-text-muted">
              {ctx.t(props.view === "modules" ? "description" : "messageDescription")}
            </p>
          </div>
        </div>
      </div>
      <div class="settings-tab-body settings-tab-body--sectioned">
        <Show when={servers().length > 1}>
          <label class="flex justify-between gap-3 text-13-regular">
            {ctx.t("server")}
            <select
              aria-label={ctx.t("server")}
              value={selected()}
              onChange={(event) => setState("server", event.currentTarget.value)}
            >
              <For each={servers()}>{(server) => <option value={server.id}>{server.name}</option>}</For>
            </select>
          </label>
        </Show>
        <Show when={selected()} keyed fallback={<p role="status">{ctx.t("offline")}</p>}>
          {(id) => <Catalog view={props.view} server={ctx.servers.get(id)} />}
        </Show>
      </div>
    </>
  )
}

function Catalog(props: { view: View; server: ServerRef | undefined }) {
  const ctx = usePlugin<typeof definition>()

  const [state, setState] = createStore<{
    modules: readonly Capability.Info[]
    messages: readonly Capability.Notice[]
    counts: Capability.Counts
    phase: "loading" | "ready" | "error" | "offline"
    refreshing: boolean
    action?: string
    failedAction: boolean
    filter: "all" | "unread" | "attention"
    next?: Capability.NoticeQuery["cursor"]
    monitor?: string
  }>({
    modules: [],
    messages: [],
    counts: { unread: 0, attention: 0 },
    phase: "loading",
    refreshing: true,
    failedAction: false,
    filter: "all",
  })

  let refresh = () => {}

  let more = () => {}

  let stop = (_id: string) => {}

  let markRead = (_value: Capability.Notice) => {}

  const monitoring = () =>
    state.modules.find((item) => item.id === state.monitor && item.state === "active" && item.metrics)

  // The live native client owns snapshots and event subscriptions. No status polling or session mutations.
  createKeyed(
    () => (props.server?.connected && props.server.compatible ? props.server.client : undefined),
    (client) => {
      const controller = new AbortController()
      const options = { signal: controller.signal }
      const rpc = client.rpc(Capability.Api)
      let revision = 0

      const read = async (append = false) => {
        const current = ++revision
        const cursor = append ? state.next : undefined
        setState("refreshing", true)

        try {
          if (props.view === "modules") {
            const modules = await rpc.list({}, options)

            if (!controller.signal.aborted && current === revision) setState({ modules, phase: "ready" })
          } else {
            const page = await rpc.notifications({ filter: state.filter, cursor, limit: 50 }, options)

            if (!controller.signal.aborted && current === revision)
              setState({
                messages: append ? [...state.messages, ...page.items] : page.items,
                counts: page.counts,
                next: page.next,
                phase: "ready",
              })
          }
        } catch {
          if (!controller.signal.aborted && current === revision) setState("phase", "error")
        } finally {
          if (!controller.signal.aborted && current === revision) setState("refreshing", false)
        }
      }

      refresh = () => {
        void read()
      }

      more = () => {
        void read(true)
      }

      const act = async (id: string, operation: () => Promise<Capability.Info | Capability.Notice>) => {
        if (state.action) return
        setState({ action: id, failedAction: false })

        try {
          await operation()

          if (!controller.signal.aborted) await read()
        } catch {
          if (!controller.signal.aborted) setState("failedAction", true)
        } finally {
          if (!controller.signal.aborted) setState("action", undefined)
        }
      }

      stop = (id) => {
        void act(id, () => rpc.stop({ id }, options))
      }

      markRead = (notice) => {
        void act(notice.moduleID + ":" + notice.id, () =>
          rpc.markRead({ moduleID: notice.moduleID, id: notice.id }, options),
        )
      }

      onCleanup(() => controller.abort())
      onCleanup(rpc.events.on("changed", () => refresh(), options))
      refresh()
    },
    { otherwise: () => setState({ phase: "offline", refreshing: false, action: undefined }) },
  )

  const open = (notice: Capability.Notice) => {
    ctx.dialogs.open(() => (
      <ctx.ui.Dialog title={notice.title}>
        <div class="px-5 pb-5 flex flex-col gap-3">
          <Show when={notice.requiresAction && notice.resolvedAt === undefined}>
            <p>{ctx.t("attention")}</p>
          </Show>
          <p class="text-13-regular whitespace-pre-wrap break-words">{notice.message ?? notice.title}</p>
        </div>
      </ctx.ui.Dialog>
    ))

    if (notice.readAt === undefined) markRead(notice)
  }

  return (
    <section class="settings-section" aria-label={ctx.t(props.view)}>
      <div class="flex justify-between items-center gap-3 pb-3">
        <div role="status" class="text-13-regular text-v2-text-text-muted">
          <Show
            when={state.phase !== "loading"}
            fallback={
              <span class="flex items-center gap-2">
                <Loader />
                {ctx.t("loading")}
              </span>
            }
          >
            <Show when={state.phase === "error" || state.phase === "offline"}>
              {ctx.t(state.phase === "offline" ? "offline" : "failed")}
            </Show>
            <Show when={props.view === "messages" && state.phase === "ready"}>
              <span class="flex flex-wrap gap-3">
                <span>{ctx.plural("count.unread", state.counts.unread, { count: state.counts.unread })}</span>
                <span>{ctx.plural("count.attention", state.counts.attention, { count: state.counts.attention })}</span>
              </span>
            </Show>
          </Show>
        </div>
        <Button
          variant="outline"
          size="small"
          onClick={() => refresh()}
          disabled={state.refreshing || state.phase === "offline"}
        >
          {ctx.t("refresh")}
        </Button>
      </div>
      <Show when={state.failedAction}>
        <p role="alert" class="text-13-regular pb-3">
          {ctx.t("actionFailed")}
        </p>
      </Show>
      <Show when={props.view === "modules"}>
        <p class="text-13-regular text-v2-text-text-muted pb-3">{ctx.t("stopDescription")}</p>
        <div class="flex flex-col gap-3">
          <For
            each={state.modules}
            fallback={
              <Show when={state.phase === "ready"}>
                <p>{ctx.t("empty")}</p>
              </Show>
            }
          >
            {(item) => (
              <article
                aria-label={item.title}
                class="border border-v2-border-border-base rounded-lg p-3 flex flex-col gap-2"
              >
                <div class="flex justify-between items-start gap-3">
                  <div class="flex flex-col gap-1">
                    <h3 class="text-14-medium">{item.title}</h3>
                    <span class="text-12-regular text-v2-text-text-muted">{item.id}</span>
                  </div>
                  <span class="text-13-regular">{ctx.t(`state.${item.state}`)}</span>
                </div>
                <Show when={item.health}>
                  {(health) => (
                    <p class="text-13-regular">
                      {ctx.t(`health.${health().phase}`)}
                      <Show when={health().message}>
                        <span class="text-v2-text-text-muted"> · {health().message}</span>
                      </Show>
                    </p>
                  )}
                </Show>
                <div class="flex gap-2">
                  <Show when={item.settings}>
                    <Button
                      size="small"
                      variant="outline"
                      onClick={() => ctx.dialogs.open(() => (
                        <ctx.ui.Dialog title={item.title}>
                          <Settings id={item.id} server={props.server} />
                        </ctx.ui.Dialog>
                      ))}
                    >
                      {ctx.t("settings")}
                    </Button>
                  </Show>
                  <Show when={item.metrics && item.state === "active"}>
                    <Button
                      size="small"
                      variant="outline"
                      onClick={() => setState("monitor", state.monitor === item.id ? undefined : item.id)}
                    >
                      {ctx.t(state.monitor === item.id ? "closeMonitor" : "monitor")}
                    </Button>
                  </Show>
                  <Show when={item.state === "active" || item.state === "loading"}>
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={!!state.action || state.phase !== "ready"}
                      onClick={() => stop(item.id)}
                    >
                      {ctx.t("stop")}
                    </Button>
                  </Show>
                </div>
              </article>
            )}
          </For>
          <Show when={monitoring()} keyed>
            {(item) => <Monitor id={item.id} server={props.server} />}
          </Show>
        </div>
      </Show>
      <Show when={props.view === "messages"}>
        <div class="flex gap-2 pb-3" role="group" aria-label={ctx.t("messages")}>
          <For each={["all", "unread", "attention"] as const}>
            {(filter) => (
              <Button
                size="small"
                variant={state.filter === filter ? "neutral" : "ghost"}
                aria-pressed={state.filter === filter}
                onClick={() => {
                  setState("filter", filter)
                  refresh()
                }}
              >
                {ctx.t(filter)}
              </Button>
            )}
          </For>
        </div>
        <div class="flex flex-col gap-3">
          <For
            each={state.messages}
            fallback={
              <Show when={state.phase === "ready"}>
                <p>{ctx.t("emptyMessages")}</p>
              </Show>
            }
          >
            {(notice) => (
              <article
                aria-label={notice.title}
                class="border border-v2-border-border-base rounded-lg p-3 flex flex-col gap-2"
              >
                <div class="flex gap-2 items-center">
                  <Show when={notice.readAt === undefined}>
                    <span
                      role="img"
                      aria-label={ctx.t("unreadMark")}
                      class="size-2 rounded-full bg-icon-critical-base shrink-0"
                    />
                  </Show>
                  <h3 class="text-14-medium">{notice.title}</h3>
                </div>
                <div class="flex gap-3 text-12-regular text-v2-text-text-muted">
                  <span>{notice.moduleID}</span>
                  <span>{notice.readAt === undefined ? ctx.t("unread") : ctx.t("read")}</span>
                  <Show when={notice.requiresAction}>
                    <span>{ctx.t(notice.resolvedAt === undefined ? "attention" : "resolved")}</span>
                  </Show>
                </div>
                <Show when={notice.message}>
                  <p class="text-13-regular line-clamp-2 break-words">{notice.message}</p>
                </Show>
                <div>
                  <Button size="small" variant="outline" disabled={!!state.action} onClick={() => open(notice)}>
                    {ctx.t("open")}
                  </Button>
                </div>
              </article>
            )}
          </For>
        </div>
        <Show when={state.next}>
          <Button class="mt-3" variant="ghost" size="small" disabled={state.refreshing} onClick={() => more()}>
            {ctx.t("more")}
          </Button>
        </Show>
      </Show>
    </section>
  )
}
