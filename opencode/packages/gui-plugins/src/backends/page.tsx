import { createMemo, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { createKeyed, usePlugin, type ServerRef } from "@opencode/plugin/gui"
import { ConversationBackend } from "@opencode/schema/conversation-backend"
import { Button } from "@opencode/ui/button"
import { Loader } from "@opencode/ui/loader"
import { Icon } from "@opencode/ui/icon"
import type definition from "./index"
import { ConversationBrowser } from "./browser"

export default function BackendsPage() {
  const ctx = usePlugin<typeof definition>()
  const [state, setState] = createStore<{ server?: string }>({})
  const servers = createMemo(() => ctx.servers.list().flatMap((id) => ctx.servers.get(id) ?? []))
  const selected = () => state.server ?? servers().find((server) => server.builtin)?.id ?? servers()[0]?.id

  return (
    <>
      <div class="settings-tab-header">
        <div class="settings-tab-header-row">
          <div class="flex flex-col gap-1">
            <h2 class="settings-tab-title">{ctx.t("title")}</h2>
            <p class="text-13-regular text-v2-text-text-muted">{ctx.t("description")}</p>
          </div>
        </div>
      </div>
      <div class="settings-tab-body settings-tab-body--sectioned">
        <Show when={servers().length > 1}>
          <label class="flex items-center justify-between gap-4 text-13-regular">
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
        <Show when={selected()} keyed fallback={<p role="status">{ctx.t("unavailable")}</p>}>
          {(id) => <BackendCatalog server={() => ctx.servers.get(id)} />}
        </Show>
      </div>
    </>
  )
}

function BackendCatalog(props: { server: () => ServerRef | undefined }) {
  const ctx = usePlugin<typeof definition>()

  const [state, setState] = createStore<{
    items: readonly ConversationBackend.Descriptor[]
    selected?: ConversationBackend.Descriptor
    phase: "loading" | "ready" | "error" | "offline"
    status?: ConversationBackend.Status
    checking: boolean
    action?: "login" | "cancel"
    pending?: ConversationBackend.BrowserLogin
    notice?: "statusFailed" | "loginFailed" | "requestUnknown" | "cancelUnknown" | "canceled" | "notFound"
  }>({ items: [], phase: "loading", checking: false })

  const available = () => state.phase === "ready" && state.items.some((item) => item.id === state.selected?.id)
  const version = { list: 0, status: 0, action: 0 }
  let refresh = () => {}

  let inspect = () => {}

  let signIn = () => {}

  let cancel = () => {}

  // Each live client owns its requests and subscriptions. No background timer or second session store.
  createKeyed(
    () => {
      const server = props.server()

      return server?.connected && server.compatible ? server.client : undefined
    },
    (client) => {
      const controller = new AbortController()
      const options = { signal: controller.signal }
      onCleanup(() => controller.abort())
      setState({ status: undefined, checking: false, action: undefined })
      const rpc = client.rpc(ConversationBackend.Api)
      const completed = new Map<string, boolean>()

      const read = async () => {
        const id = state.selected?.id
        const revision = ++version.status

        if (!id || !available()) return
        setState({ checking: true, notice: undefined })

        const current = () =>
          !controller.signal.aborted && revision === version.status && state.selected?.id === id && available()

        try {
          const status = await rpc.status({ backendID: id }, options)

          if (!current()) return
          setState("status", status)

          if (status.authentication?.state === "signed-in") setState("pending", undefined)
        } catch {
          if (current()) setState({ status: undefined, notice: "statusFailed" })
        } finally {
          if (current()) setState("checking", false)
        }
      }

      const list = async () => {
        const revision = ++version.list
        setState("phase", "loading")

        try {
          const items = await rpc.list({}, options)

          if (controller.signal.aborted || revision !== version.list) return
          const selected = state.selected
          // An offline selection stays selected; it never falls back to another executor.
          setState({
            items,
            phase: "ready",
            selected: selected ? (items.find((item) => item.id === selected.id) ?? selected) : items[0],
          })

          if (!available()) setState({ status: undefined, pending: undefined, checking: false })
          await read()
        } catch {
          if (!controller.signal.aborted && revision === version.list)
            setState({ phase: "error", status: undefined, checking: false })
        }
      }

      refresh = () => {
        void list()
      }

      inspect = () => {
        void read()
      }

      signIn = () => {
        const id = state.selected?.id

        if (!id || !available() || state.action || !props.server()?.local) return
        const revision = ++version.action
        completed.clear()
        setState({ action: "login", notice: undefined })
        void rpc
          .login({ backendID: id }, options)
          .then(
            (login) => {
              if (controller.signal.aborted || revision !== version.action || state.selected?.id !== id) return
              const result = completed.get(login.id)

              if (result !== undefined) {
                if (!result) setState("notice", "loginFailed")

                return
              }

              setState("pending", login)
            },
            () => {
              if (!controller.signal.aborted && revision === version.action) setState("notice", "requestUnknown")
            },
          )
          .finally(() => {
            if (!controller.signal.aborted && revision === version.action) setState("action", undefined)
          })
      }

      cancel = () => {
        const login = state.pending
        const id = state.selected?.id

        if (!login || !id || !available() || state.action) return
        const revision = ++version.action
        setState("action", "cancel")
        void rpc
          .cancelLogin({ backendID: id, loginID: login.id }, options)
          .then(
            async (result) => {
              if (controller.signal.aborted || revision !== version.action) return
              setState("pending", undefined)
              await read()

              if (!controller.signal.aborted && revision === version.action)
                setState("notice", result === "canceled" ? "canceled" : "notFound")
            },
            () => {
              if (!controller.signal.aborted && revision === version.action) setState("notice", "cancelUnknown")
            },
          )
          .finally(() => {
            if (!controller.signal.aborted && revision === version.action) setState("action", undefined)
          })
      }

      onCleanup(
        rpc.events.on(
          "changed",
          () => {
            void list()
          },
          options,
        ),
      )
      onCleanup(
        rpc.events.on(
          "authentication",
          ({ data }) => {
            if (data.backendID !== state.selected?.id) return
            let failed = false

            if (data.event.type === "completed") {
              if (state.action === "login") completed.set(data.event.loginID, data.event.success)

              if (state.pending?.id === data.event.loginID) {
                setState("pending", undefined)
                failed = !data.event.success && state.action !== "cancel"
              }
            }

            const selectedID = state.selected?.id
            void read().then(() => {
              if (!controller.signal.aborted && failed && state.selected?.id === selectedID)
                setState("notice", "loginFailed")
            })
          },
          options,
        ),
      )
      // Reads inside async actions are not dependencies of the client's lifetime.
      refresh()
    },
    { otherwise: () => setState({ phase: "offline", status: undefined, checking: false, action: undefined }) },
  )

  const select = (item: ConversationBackend.Descriptor) => {
    if (state.action) return
    setState({ selected: item, status: undefined, pending: undefined, notice: undefined })
    inspect()
  }

  return (
    <section class="settings-section" aria-label={ctx.t("title")}>
      <div class="flex items-center justify-between gap-3 pb-3">
        <span role="status" class="text-13-regular text-v2-text-text-muted">
          <Show
            when={state.phase !== "loading"}
            fallback={
              <span class="flex items-center gap-2">
                <Loader />
                {ctx.t("loading")}
              </span>
            }
          >
            {ctx.t(
              ({ error: "failed", offline: "unavailable", ready: "connected", loading: "loading" } as const)[
                state.phase
              ],
            )}
          </Show>
        </span>
        <Button
          size="small"
          variant="outline"
          onClick={() => refresh()}
          disabled={!props.server()?.connected || !!state.action || state.phase === "loading"}
        >
          {ctx.t("refresh")}
        </Button>
      </div>
      <div data-component="settings-list" role="group" aria-label={ctx.t("title")}>
        <For each={state.items}>
          {(item) => (
            <button
              type="button"
              data-component="settings-row"
              class="w-full text-start"
              aria-pressed={state.selected?.id === item.id}
              disabled={!!state.action}
              onClick={() => select(item)}
            >
              <span data-slot="settings-row-copy">
                <span data-slot="settings-row-title">{item.label}</span>
                <span data-slot="settings-row-description">{item.id}</span>
              </span>
              <Show when={state.selected?.id === item.id}>
                <Icon name="check" class="text-v2-icon-icon-accent" />
              </Show>
            </button>
          )}
        </For>
      </div>
      <Show when={state.phase === "ready" && !state.items.length && !state.selected}>
        <p class="text-13-regular text-v2-text-text-muted">{ctx.t("empty")}</p>
      </Show>
      <Show when={state.selected}>
        {(selected) => (
          <section class="settings-section pt-5" aria-label={selected().label}>
            <h3 class="settings-section-title">{selected().label}</h3>
            <Show when={available()} fallback={<p role="status">{ctx.t("unavailable")}</p>}>
              <Show when={selected().browse}>
                <Button
                  variant="outline"
                  onClick={() => {
                    const backend = state.selected

                    if (!backend || !available()) return

                    const dialog = ctx.dialogs.open(() => (
                      <ConversationBrowser
                        server={props.server}
                        backend={backend}
                        onOpen={(thread) => {
                          const server = props.server()

                          if (!server) return
                          ctx.tabs.openBackend(
                            { server: server.id, ref: thread.ref, title: thread.title },
                            { focus: true },
                          )
                          dialog.close()
                        }}
                      />
                    ))
                  }}
                >
                  {ctx.t("browse.open")}
                </Button>
              </Show>
              <Show
                when={!state.checking}
                fallback={
                  <p role="status" class="flex items-center gap-2">
                    <Loader />
                    {ctx.t("checking")}
                  </p>
                }
              >
                <Show when={state.status}>
                  {(status) => (
                    <>
                      <p role="status" class="text-13-regular">
                        {ctx.t(status().authentication?.state ?? "unsupported")}
                      </p>
                      <dl class="text-13-regular">
                        <Show when={status().authentication?.label}>
                          {(label) => (
                            <div class="flex justify-between gap-3 py-1">
                              <dt>{ctx.t("account")}</dt>
                              <dd>{label()}</dd>
                            </div>
                          )}
                        </Show>
                        <Show when={status().authentication?.plan}>
                          {(plan) => (
                            <div class="flex justify-between gap-3 py-1">
                              <dt>{ctx.t("plan")}</dt>
                              <dd>{plan()}</dd>
                            </div>
                          )}
                        </Show>
                      </dl>
                      <Show when={status().authentication?.state === "signed-out" && !state.pending}>
                        <Show when={props.server()?.local} fallback={<p>{ctx.t("localOnly")}</p>}>
                          <Button onClick={() => signIn()} disabled={!!state.action}>
                            {state.action === "login" ? ctx.t("starting") : ctx.t("signIn")}
                          </Button>
                        </Show>
                      </Show>
                    </>
                  )}
                </Show>
              </Show>
              <Show when={state.pending}>
                {(login) => (
                  <div class="flex flex-col items-start gap-3 py-3">
                    <p role="status">{ctx.t("pending")}</p>
                    <div class="flex flex-wrap gap-2">
                      <Button onClick={() => ctx.system.openExternal(login().url)}>{ctx.t("open")}</Button>
                      <Button variant="outline" onClick={() => cancel()} disabled={!!state.action}>
                        {ctx.t("cancel")}
                      </Button>
                    </div>
                  </div>
                )}
              </Show>
              <Button
                size="small"
                variant="ghost"
                onClick={() => inspect()}
                disabled={state.checking || !!state.action}
              >
                {ctx.t("refreshAccount")}
              </Button>
            </Show>
            <Show when={state.notice}>
              {(notice) => (
                <p role="status" class="text-13-regular text-v2-text-text-muted pt-2">
                  {ctx.t(notice())}
                </p>
              )}
            </Show>
          </section>
        )}
      </Show>
    </section>
  )
}
