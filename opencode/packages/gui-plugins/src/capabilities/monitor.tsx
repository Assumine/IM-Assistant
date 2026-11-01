import { createKeyed, usePlugin, type ServerRef } from "@opencode/plugin/gui"
import { Capability } from "@opencode/schema/capability"
import { For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Loader } from "@opencode/ui/loader"
import type definition from "./index"

export default function Monitor(props: { id: string; server: ServerRef | undefined }) {
  const ctx = usePlugin<typeof definition>()
  const [state, setState] = createStore<{ pending: boolean; result?: Capability.Metrics }>({ pending: true })
  // The visible panel alone owns the timer and in-flight read. Hidden documents have neither.
  createKeyed(
    () => (props.server?.connected ? props.server.client : undefined),
    (client) => {
      const rpc = client.rpc(Capability.Api)

      let disposed = false,
        reading = false

      let timer: ReturnType<typeof setTimeout> | undefined
      let request: AbortController | undefined

      const clear = () => {
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
      }

      const read = async () => {
        if (disposed || document.hidden || reading) return
        clear()
        reading = true
        request = new AbortController()
        const current = request
        setState("pending", true)

        try {
          const result = await rpc.metrics({ id: props.id }, { signal: current.signal })

          if (!disposed && !current.signal.aborted) setState("result", result)
        } catch {
          if (!disposed && !current.signal.aborted) setState("result", { id: props.id, status: "failed", items: [] })
        } finally {
          reading = false

          if (!disposed) {
            setState("pending", false)

            if (!document.hidden) timer = setTimeout(() => void read(), 1000)
          }
        }
      }

      const visibility = () => {
        clear()

        if (document.hidden) request?.abort()
        else void read()
      }

      document.addEventListener("visibilitychange", visibility)
      onCleanup(() => {
        disposed = true
        clear()
        request?.abort()
        document.removeEventListener("visibilitychange", visibility)
      })
      void read()
    },
    { otherwise: () => setState({ pending: false, result: { id: props.id, status: "unavailable", items: [] } }) },
  )

  return (
    <section
      aria-label={ctx.t("monitor")}
      class="border border-v2-border-border-base rounded-lg p-3 flex flex-col gap-3"
    >
      <p class="text-13-regular text-v2-text-text-muted">{ctx.t("monitorDescription")}</p>
      <Show
        when={state.result}
        fallback={
          <span role="status">
            <Loader />
          </span>
        }
      >
        {(result) => (
          <>
            <Show
              when={result().status === "ready"}
              fallback={
                <p role="status">{ctx.t(`metric.${result().status === "ready" ? "failed" : result().status}`)}</p>
              }
            >
              <For each={result().items} fallback={<p>{ctx.t("metric.empty")}</p>}>
                {(item) => (
                  <div class="flex flex-col gap-1">
                    <div class="flex justify-between gap-3 text-13-regular">
                      <span>{item.label}</span>
                      <span>{ctx.t(`unit.${item.unit}`, { value: item.value.toLocaleString() })}</span>
                    </div>
                    <Show when={item.unit === "percent"}>
                      <progress
                        aria-label={item.label}
                        class="w-full h-1.5"
                        value={Math.max(0, Math.min(100, item.value))}
                        max={100}
                      />
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          </>
        )}
      </Show>
    </section>
  )
}
