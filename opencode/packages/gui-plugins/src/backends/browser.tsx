import { For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { createKeyed, usePlugin, type ServerRef } from "@opencode/plugin/gui"
import { ConversationBackend } from "@opencode/schema/conversation-backend"
import { Dialog, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Button } from "@opencode/ui/button"
import { Loader } from "@opencode/ui/loader"
import { Spinner } from "@opencode/ui/spinner"
import type definition from "./index"

export function ConversationBrowser(props: {
  server: () => ServerRef | undefined
  backend: ConversationBackend.Descriptor
  thread?: ConversationBackend.Thread
  embedded?: boolean
  onOpen?: (thread: ConversationBackend.Thread) => void
  onThread?: (thread: ConversationBackend.Thread) => void
}) {
  const ctx = usePlugin<typeof definition>()

  const [state, setState] = createStore<{
    threads: readonly ConversationBackend.Thread[]
    selected?: ConversationBackend.Thread
    listCursor?: string
    history?: ConversationBackend.History
    listing: boolean
    reading: boolean
    connected: boolean
    error?: "listFailed" | "historyFailed"
  }>({ threads: [], selected: props.thread, listing: false, reading: false, connected: false })

  let viewport: HTMLDivElement | undefined
  let list = (_more = false) => {}

  let read = (_thread: ConversationBackend.Thread, _older = false) => {}

  // Own only the visible snapshot. The backend owns history, pagination and execution.
  createKeyed(
    () => {
      const server = props.server()

      return server?.connected && server.compatible ? server.client : undefined
    },
    (client) => {
      const controller = new AbortController()
      const options = { signal: controller.signal }
      const rpc = client.rpc(ConversationBackend.Api)
      const version = { list: 0, history: 0 }
      onCleanup(() => controller.abort())
      setState({ connected: true, listing: false, reading: false })

      read = (thread, older = false) => {
        const cursor = older ? state.history?.nextCursor : undefined

        if (older && !cursor) return
        const revision = ++version.history
        const existing = state.selected?.ref.threadID === thread.ref.threadID ? state.history : undefined
        setState({ selected: thread, history: existing, reading: true, error: undefined })

        const current = () =>
          !controller.signal.aborted &&
          revision === version.history &&
          state.selected?.ref.threadID === thread.ref.threadID

        void rpc.history({ ref: thread.ref, limit: 20, cursor }, options).then(
          (page) => {
            if (!current()) return
            const element = viewport
            const previous = element && { height: element.scrollHeight, top: element.scrollTop }
            const seen = new Set(existing?.items.map((item) => `${item.turnID}\0${item.id}`))

            const items = older
              ? [...page.items.filter((item) => !seen.has(`${item.turnID}\0${item.id}`)), ...(existing?.items ?? [])]
              : page.items

            setState({ selected: page.thread, history: { ...page, items }, reading: false })
            props.onThread?.(page.thread)
            // Text records have synchronous layout; preserve the visible record when prepending an older page.
            queueMicrotask(() => {
              if (!current() || !element || viewport !== element) return
              element.scrollTop =
                older && previous ? previous.top + element.scrollHeight - previous.height : element.scrollHeight
            })
          },
          () => {
            if (current()) setState({ reading: false, error: "historyFailed" })
          },
        )
      }

      list = (more = false) => {
        const cursor = more ? state.listCursor : undefined

        if (more && !cursor) return
        const revision = ++version.list
        setState({ listing: true, error: undefined })
        void rpc.threads({ backendID: props.backend.id, limit: 20, cursor }, options).then(
          (page) => {
            if (controller.signal.aborted || revision !== version.list) return
            const seen = new Set(state.threads.map((thread) => thread.ref.threadID))
            setState({
              threads: more
                ? [...state.threads, ...page.items.filter((thread) => !seen.has(thread.ref.threadID))]
                : page.items,
              listCursor: page.nextCursor,
              listing: false,
            })
          },
          () => {
            if (!controller.signal.aborted && revision === version.list)
              setState({ listing: false, error: "listFailed" })
          },
        )
      }

      onCleanup(
        rpc.events.on(
          "changed",
          () => {
            if (props.thread && state.selected) read(state.selected)
            else list()
          },
          options,
        ),
      )

      if (!props.thread) list()

      if (state.selected) read(state.selected)
    },
    { otherwise: () => setState({ connected: false, listing: false, reading: false }) },
  )

  const selected = () => state.selected
  const history = () => (state.history?.thread.ref.threadID === selected()?.ref.threadID ? state.history : undefined)

  const content = () => (
    <>
      <Show
        when={!props.embedded}
        fallback={
          <header class="flex shrink-0 flex-col gap-1 px-5 py-4">
            <h2 class="text-16-medium">{selected()?.title ?? props.backend.label}</h2>
            <p class="text-13-regular text-v2-text-text-muted">{ctx.t("browse.description")}</p>
          </header>
        }
      >
        <DialogHeader>
          <DialogTitleGroup title={props.backend.label} description={ctx.t("browse.description")} />
        </DialogHeader>
      </Show>
      <div
        class="flex min-h-0 w-full flex-col border-t border-v2-border-border-muted md:flex-row"
        classList={{ "h-[min(70vh,720px)]": !props.embedded, "flex-1": props.embedded }}
      >
        <Show when={!props.thread}>
          <aside
            class="flex max-h-48 min-h-0 flex-col border-b border-v2-border-border-muted md:max-h-none md:w-64 md:shrink-0 md:border-b-0 md:border-r"
            aria-label={ctx.t("browse.list")}
          >
            <div class="flex items-center justify-between gap-2 px-4 py-3">
              <h3 class="text-13-regular font-medium">{ctx.t("browse.list")}</h3>
              <Button size="small" variant="ghost" disabled={!state.connected || state.listing} onClick={() => list()}>
                {ctx.t("browse.refreshList")}
              </Button>
            </div>
            <div data-scrollable class="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
              <For each={state.threads}>
                {(thread) => (
                  <button
                    type="button"
                    class="flex w-full items-center gap-2 rounded-md px-2 py-3 text-start hover:bg-v2-background-bg-layer-01 aria-pressed:bg-v2-background-bg-layer-01"
                    aria-label={thread.title}
                    aria-pressed={selected()?.ref.threadID === thread.ref.threadID}
                    disabled={!state.connected}
                    onClick={() => read(thread)}
                  >
                    <Show when={thread.state === "running" || thread.state === "waiting"}>
                      <Spinner />
                    </Show>
                    <span class="flex min-w-0 flex-1 flex-col gap-1">
                      <span class="truncate text-13-regular" title={thread.title}>
                        {thread.title}
                      </span>
                      <span class="text-11-regular text-v2-text-text-muted">
                        {ctx.t(`browse.state.${thread.state}`)}
                      </span>
                    </span>
                  </button>
                )}
              </For>
              <Show when={state.listing}>
                <p role="status" class="flex items-center gap-2 px-2 py-3">
                  <Loader />
                  {ctx.t("browse.loadingList")}
                </p>
              </Show>
              <Show when={!state.listing && !state.threads.length && !state.error && state.connected}>
                <p class="p-2 text-13-regular text-v2-text-text-muted">{ctx.t("browse.empty")}</p>
              </Show>
              <Show when={state.listCursor}>
                <Button
                  size="small"
                  variant="ghost"
                  disabled={state.listing || !state.connected}
                  onClick={() => list(true)}
                >
                  {ctx.t("browse.more")}
                </Button>
              </Show>
            </div>
          </aside>
        </Show>
        <section class="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={ctx.t("browse.history")}>
          <Show when={!state.connected}>
            <p role="alert" class="px-5 py-3 text-13-regular text-v2-text-text-muted">
              {ctx.t("browse.offline")}
            </p>
          </Show>
          <Show when={state.error}>
            {(error) => (
              <p role="alert" class="px-5 py-3 text-13-regular">
                {ctx.t(`browse.${error()}`)}
              </p>
            )}
          </Show>
          <Show
            when={selected()}
            fallback={<p class="m-auto p-5 text-13-regular text-v2-text-text-muted">{ctx.t("browse.select")}</p>}
          >
            {(thread) => (
              <>
                <div class="flex items-center justify-between gap-3 border-b border-v2-border-border-muted px-5 py-3">
                  <Show when={!props.embedded}>
                    <h3 class="min-w-0 truncate text-13-regular font-medium" title={thread().title}>
                      {thread().title}
                    </h3>
                  </Show>
                  <Show when={props.onOpen}>
                    <Button size="small" variant="outline" onClick={() => props.onOpen?.(thread())}>
                      {ctx.t("browse.openTab")}
                    </Button>
                  </Show>
                  <Button
                    size="small"
                    variant="ghost"
                    class="ms-auto"
                    disabled={state.reading || !state.connected}
                    onClick={() => read(thread())}
                  >
                    {ctx.t("browse.refreshHistory")}
                  </Button>
                </div>
                <div
                  ref={viewport}
                  data-scrollable
                  class="min-h-0 flex-1 overflow-y-auto px-5 py-4"
                  aria-label={ctx.t("browse.history")}
                >
                  <Show when={history()?.nextCursor}>
                    <Button
                      size="small"
                      variant="outline"
                      disabled={state.reading || !state.connected}
                      onClick={() => read(thread(), true)}
                    >
                      {ctx.t("browse.earlier")}
                    </Button>
                  </Show>
                  <Show when={state.reading}>
                    <p role="status" class="flex items-center gap-2 py-3">
                      <Loader />
                      {ctx.t("browse.loadingHistory")}
                    </p>
                  </Show>
                  <ol class="flex flex-col gap-5 py-4">
                    <For each={history()?.items}>
                      {(item) => (
                        <li>
                          <article
                            aria-label={ctx.t(`browse.kind.${item.kind}`)}
                            class={`flex flex-col gap-2 text-13-regular leading-[var(--line-height-base)] ${item.kind === "user" ? "rounded-lg bg-v2-background-bg-layer-01 px-4 py-3" : ""}`}
                          >
                            <header class="flex items-center justify-between gap-3 text-11-regular text-v2-text-text-muted">
                              <span>{ctx.t(`browse.kind.${item.kind}`)}</span>
                              <Show when={item.timestamp}>
                                {(time) => (
                                  <time dateTime={new Date(time()).toISOString()}>
                                    {new Date(time()).toLocaleString(ctx.locale.locale())}
                                  </time>
                                )}
                              </Show>
                            </header>
                            <Show when={item.text}>
                              <p class="whitespace-pre-wrap break-words">{item.text}</p>
                            </Show>
                            <Show when={item.partial}>
                              <p class="text-v2-text-text-muted">{ctx.t("browse.partial")}</p>
                            </Show>
                          </article>
                        </li>
                      )}
                    </For>
                  </ol>
                  <Show when={history()?.items.length === 0 && !state.reading}>
                    <p class="text-13-regular text-v2-text-text-muted">{ctx.t("browse.noHistory")}</p>
                  </Show>
                </div>
              </>
            )}
          </Show>
        </section>
      </div>
    </>
  )

  return props.embedded ? (
    <div class="flex size-full min-h-0 flex-col">{content()}</div>
  ) : (
    <Dialog size="x-large">{content()}</Dialog>
  )
}
