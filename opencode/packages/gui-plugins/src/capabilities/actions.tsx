import { usePlugin, type ServerRef } from "@opencode/plugin/gui"
import { Capability } from "@opencode/schema/capability"
import { Button } from "@opencode/ui/button"
import { uuid } from "@opencode/util/uuid"
import { For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type definition from "./index"

export default function Actions(props: {
  id: string
  actions?: readonly Capability.ViewAction[]
  server?: ServerRef
  refresh: () => void
}) {
  return (
    <div class="flex flex-col gap-2">
      <For each={props.actions?.map((action) => action.id)}>
        {(id) => (
          <Show when={props.actions?.find((action) => action.id === id)}>
            {(action) => <Action id={props.id} action={action()} server={props.server} refresh={props.refresh} />}
          </Show>
        )}
      </For>
    </div>
  )
}

function Action(props: { id: string; action: Capability.ViewAction; server?: ServerRef; refresh: () => void }) {
  const ctx = usePlugin<typeof definition>()

  const [state, setState] = createStore<{
    open: boolean
    pending: boolean
    requestID: string
    values: Record<string, string>
    result?: Capability.ActionResult
  }>({
    open: false,
    pending: false,
    requestID: uuid(),
    values: {},
  })

  let request: AbortController | undefined
  onCleanup(() => request?.abort())

  const submit = async () => {
    const client = props.server?.connected && props.server.compatible ? props.server.client : undefined

    if (!client || state.pending) return
    request = new AbortController()
    const current = request
    setState("pending", true)

    try {
      const result = await client
        .rpc(Capability.Api)
        .invoke(
          {
            id: props.id,
            action: props.action.id,
            requestID: state.requestID,
            target: props.action.target,
            values: JSON.stringify(state.values),
            locale: ctx.locale.locale(),
          },
          { signal: current.signal },
        )

      if (current.signal.aborted || props.server?.client !== client) return
      setState("result", result)
      props.refresh()
    } catch {
      if (!current.signal.aborted && props.server?.client === client)
        setState("result", { state: "uncertain", message: ctx.t("action.unknown") })
    } finally {
      if (!current.signal.aborted && props.server?.client === client) setState("pending", false)
    }
  }

  return (
    <div class="min-w-0 flex flex-col items-start gap-2">
      <Button
        size="small"
        variant="outline"
        disabled={state.pending || !props.server?.connected}
        onClick={() => (props.action.fields?.length ? setState("open", !state.open) : void submit())}
      >
        {props.action.label}
      </Button>
      <Show when={state.open && props.action.fields?.length}>
        <form
          class="w-full flex flex-col gap-2 border border-v2-border-border-base rounded-md p-3"
          aria-label={props.action.label}
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <For each={props.action.fields?.map((field) => field.name)}>
            {(name) => (
              <Show when={props.action.fields?.find((field) => field.name === name)}>
                {(field) => (
                  <label class="flex flex-col gap-1 text-13-regular">
                    {field().label}
                    <input
                      class="rounded-md border border-v2-border-border-base px-3 py-2 bg-transparent"
                      name={field().name}
                      value={state.values[field().name] ?? ""}
                      placeholder={field().placeholder}
                      required={field().required}
                      maxLength={8192}
                      disabled={state.pending || state.result?.state === "uncertain"}
                      onInput={(event) => {
                        if (state.result?.state === "applied")
                          setState({ requestID: uuid(), result: undefined })
                        setState("values", field().name, event.currentTarget.value)
                      }}
                    />
                  </label>
                )}
              </Show>
            )}
          </For>
          <Button type="submit" size="small" disabled={state.pending}>
            {state.pending
              ? ctx.t("action.pending")
              : state.result?.state === "uncertain"
                ? ctx.t("action.check")
                : props.action.label}
          </Button>
        </form>
      </Show>
      <Show when={state.result}>
        {(result) => (
          <p role="status" class="text-13-regular break-words">
            {result().message}
          </p>
        )}
      </Show>
      <Show when={state.result?.state === "uncertain"}>
        <Button
          size="small"
          variant="ghost"
          onClick={() => setState({ values: {}, result: undefined, requestID: uuid() })}
        >
          {ctx.t("action.new")}
        </Button>
      </Show>
    </div>
  )
}
