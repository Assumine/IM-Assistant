import { createKeyed, usePlugin, type ServerRef } from "@opencode/plugin/gui"
import { Capability } from "@opencode/schema/capability"
import { Button } from "@opencode/ui/button"
import { Loader } from "@opencode/ui/loader"
import { For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type definition from "./index"
import Actions from "./actions"

/** Bounded module data and explicit controls. Refresh only while visible when the owner requests it. */
export default function View(props: { id: string; server: ServerRef | undefined }) {
  const ctx = usePlugin<typeof definition>()
  const [state, setState] = createStore<{ pending: boolean; result?: Capability.ViewResult }>({ pending: true })
  let refresh = () => {}

  createKeyed(
    () => (props.server?.connected && props.server.compatible ? props.server.client : undefined),
    (client) => {
      const rpc = client.rpc(Capability.Api)
      const lifetime = new AbortController()
      let request: AbortController | undefined
      let timer: ReturnType<typeof setTimeout> | undefined

      const read = async () => {
        clearTimeout(timer)

        if (document.hidden || lifetime.signal.aborted) return
        request?.abort()
        const current = new AbortController()
        request = current
        setState("pending", true)

        try {
          const result = await rpc.view({ id: props.id, locale: ctx.locale.locale() }, { signal: current.signal })

          if (!current.signal.aborted && !lifetime.signal.aborted) {
            setState("result", result)

            if (result.status === "ready" && result.document?.refreshAfterMs)
              timer = setTimeout(refresh, result.document.refreshAfterMs)
          }
        } catch {
          if (!current.signal.aborted && !lifetime.signal.aborted)
            setState("result", { id: props.id, status: "failed" })
        } finally {
          if (!current.signal.aborted && !lifetime.signal.aborted) setState("pending", false)
        }
      }

      refresh = () => {
        void read()
      }

      const visibility = () => {
        if (document.hidden) {
          request?.abort()
          clearTimeout(timer)
        } else refresh()
      }

      document.addEventListener("visibilitychange", visibility)
      onCleanup(
        rpc.events.on(
          "viewChanged",
          (event) => {
            if (event.data.id === props.id) refresh()
          },
          { signal: lifetime.signal },
        ),
      )
      onCleanup(() => {
        lifetime.abort()
        request?.abort()
        clearTimeout(timer)
        document.removeEventListener("visibilitychange", visibility)
      })
      refresh()
    },
    { otherwise: () => setState({ pending: false, result: { id: props.id, status: "unavailable" } }) },
  )

  return (
    <section
      aria-label={ctx.t("activity")}
      class="min-w-0 border-t border-v2-border-border-base pt-3 flex flex-col gap-3"
    >
      <div class="flex items-center justify-between gap-3">
        <h4 class="text-14-medium">{state.result?.document?.title ?? ctx.t("activity")}</h4>
        <Button size="small" variant="ghost" disabled={state.pending} onClick={() => refresh()}>
          {ctx.t("refresh")}
        </Button>
      </div>
      <Show
        when={state.result}
        fallback={
          <span role="status">
            <Loader />
            {ctx.t("loading")}
          </span>
        }
      >
        {(result) => (
          <Show
            when={result().status === "ready" && result().document}
            fallback={<p role="status">{ctx.t(`view.${result().status === "ready" ? "failed" : result().status}`)}</p>}
          >
            {(content) => (
              <>
                <Show when={content().description}>
                  <p class="text-13-regular text-v2-text-text-muted break-words">{content().description}</p>
                </Show>
                <Actions id={props.id} actions={content().actions} server={props.server} refresh={() => refresh()} />
                <For
                  each={content().items.map((item) => item.id)}
                  fallback={<p class="text-14-regular">{content().empty ?? ctx.t("view.empty")}</p>}
                >
                  {(id) => (
                    <Show when={content().items.find((item) => item.id === id)}>
                      {(item) => (
                        <article
                          aria-label={item().title}
                          class="min-w-0 rounded-md border border-v2-border-border-base p-3 flex flex-col gap-2"
                        >
                          <div class="flex justify-between items-start gap-3">
                            <div class="min-w-0 flex flex-col gap-1">
                              <h5 class="text-14-medium break-words">{item().title}</h5>
                              <Show when={item().subtitle}>
                                <p class="text-12-regular text-v2-text-text-muted break-words">{item().subtitle}</p>
                              </Show>
                            </div>
                            <span role="status" class="shrink-0 flex items-center gap-1.5 text-13-regular">
                              <Show when={item().state === "running"}>
                                <Loader class="size-4" />
                              </Show>
                              {item().status}
                            </span>
                          </div>
                          <Show when={item().progress !== undefined}>
                            <div
                              role="progressbar"
                              aria-label={item().title}
                              aria-valuenow={item().progress}
                              aria-valuemin={0}
                              aria-valuemax={100}
                              class="h-1.5 w-full overflow-hidden rounded-full bg-v2-border-border-base"
                            >
                              <div
                                class="h-full bg-current transition-[width] duration-150"
                                style={{ width: `${item().progress}%` }}
                              />
                            </div>
                          </Show>
                          <dl class="grid grid-cols-[minmax(5rem,7rem)_minmax(0,1fr)] gap-x-3 gap-y-2 text-14-regular">
                            <For each={item().fields}>
                              {(field) => (
                                <div class="contents">
                                  <dt class="text-12-regular text-v2-text-text-muted">{field.label}</dt>
                                  <dd class="m-0 whitespace-pre-wrap break-words">{field.value}</dd>
                                </div>
                              )}
                            </For>
                          </dl>
                          <Show when={item().technical}>
                            <details class="min-w-0 border-t border-v2-border-border-base pt-2">
                              <summary class="cursor-pointer text-13-regular text-v2-text-text-muted">
                                {ctx.t("technical")}
                              </summary>
                              <pre
                                data-scrollable
                                class="mt-2 max-h-60 overflow-auto min-w-0 whitespace-pre-wrap break-all text-12-regular"
                              >
                                {item().technical}
                              </pre>
                            </details>
                          </Show>
                          <Actions
                            id={props.id}
                            actions={item().actions}
                            server={props.server}
                            refresh={() => refresh()}
                          />
                        </article>
                      )}
                    </Show>
                  )}
                </For>
              </>
            )}
          </Show>
        )}
      </Show>
    </section>
  )
}
