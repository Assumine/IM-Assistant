import { onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { createKeyed, usePlugin, type ServerRef, type UiQueueView } from "@opencode/plugin/gui"
import { ConversationBackend } from "@opencode/schema/conversation-backend"
import { Spinner } from "@opencode/ui/spinner"
import type definition from "./index"

/** A visible projection and explicit controls; execution and pending inputs stay entirely in the native backend. */
export function Execution(props: {
  serverID: string
  threadRef: ConversationBackend.Ref
  serverRef: () => ServerRef | undefined
  onAccepted?: () => void
}) {
  const ctx = usePlugin<typeof definition>()

  const [state, setState] = createStore<{
    supported: boolean
    connected: boolean
    reading: boolean
    controlling: boolean
    value?: ConversationBackend.Execution
    error?: "readFailed" | "controlUnknown"
  }>({ supported: false, connected: false, reading: false, controlling: false })

  let refresh = () => {}

  let inspect = () => {}

  let control = async (_action: ConversationBackend.Control) => {}

  // Subscribe only while this native view has a live server generation. No background polling or task scheduling.
  createKeyed(
    () => {
      const server = props.serverRef()

      return server?.connected && server.compatible ? server.client : undefined
    },
    (client) => {
      const lifetime = new AbortController()
      const options = { signal: lifetime.signal }
      const rpc = client.rpc(ConversationBackend.Api)
      const requests = { reading: false, dirty: false, listing: 0 }
      setState({ connected: true, supported: false, controlling: false })
      onCleanup(() => lifetime.abort())

      refresh = () => {
        if (lifetime.signal.aborted || !state.supported) return

        if (requests.reading) {
          requests.dirty = true

          return
        }

        requests.reading = true
        setState("reading", true)
        void rpc
          .execution({ ref: props.threadRef, limit: 100 }, options)
          .then(
            (value) => {
              if (lifetime.signal.aborted) return
              setState({ value, error: state.error === "readFailed" ? undefined : state.error })
            },
            () => {
              if (!lifetime.signal.aborted) setState("error", "readFailed")
            },
          )
          .finally(() => {
            if (lifetime.signal.aborted) return
            requests.reading = false
            setState("reading", false)

            if (!requests.dirty) return
            requests.dirty = false
            refresh()
          })
      }

      const list = () => {
        const revision = ++requests.listing
        void rpc.list({}, options).then(
          (backends) => {
            if (lifetime.signal.aborted || revision !== requests.listing) return
            setState(
              "supported",
              backends.some((backend) => backend.id === props.threadRef.backendID && backend.execution),
            )

            if (state.supported) refresh()
          },
          () => {
            if (lifetime.signal.aborted || revision !== requests.listing) return
            setState({ supported: false, error: "readFailed" })
          },
        )
      }

      inspect = list

      control = async (action) => {
        if (lifetime.signal.aborted || queue.busy()) return
        setState({ controlling: true, error: undefined })
        // Once dispatched, a native write survives navigation. Only this view's late UI result is discarded.
        await rpc.control({ backendID: props.threadRef.backendID, control: action }).catch(() => {
          if (!lifetime.signal.aborted) setState("error", "controlUnknown")
        })

        if (lifetime.signal.aborted) return
        setState("controlling", false)
        // Acknowledgement is not a queue snapshot. Re-read after success or an unknown result, never retry controls.
        refresh()
      }

      onCleanup(rpc.events.on("changed", list, options))
      onCleanup(
        rpc.events.on(
          "activity",
          ({ data: event }) => {
            if (event.ref.backendID !== props.threadRef.backendID || event.ref.threadID !== props.threadRef.threadID)
              return

            if (event.change !== "history") refresh()
          },
          options,
        ),
      )
      list()
    },
    { otherwise: () => setState({ connected: false, reading: false, controlling: false }) },
  )

  const working = () => state.connected && state.supported && state.value?.thread.state === "running"

  const queue: UiQueueView = {
    rows: () => state.value?.queue.map((item) => ({ id: item.nativeID, text: item.text, attachments: 0 })) ?? [],
    editing: () => undefined,
    working,
    busy: () =>
      !state.connected ||
      !state.supported ||
      !state.value ||
      state.reading ||
      state.controlling ||
      !!state.error ||
      !["running", "waiting", "idle"].includes(state.value.thread.state),
    // There is no draft/undo/edit adapter yet; those controls are absent rather than pretending to work.
    get steer() {
      if (state.value?.thread.state !== "running" || state.value.turn?.state !== "running") return

      return (nativeID: string) => control({ action: "guide", threadID: props.threadRef.threadID, nativeID })
    },
    remove: (nativeID) => control({ action: "withdraw", threadID: props.threadRef.threadID, nativeID }),
    get reorder() {
      // A partial page is not the full order and must never truncate the real queue.
      if (state.value?.nextCursor) return

      return (nativeIDs: string[]) => control({ action: "reorder", threadID: props.threadRef.threadID, nativeIDs })
    },
  }

  return (
    <Show when={state.supported || state.error}>
      <section
        class="flex shrink-0 flex-col gap-2 border-t border-v2-border-border-muted px-5 py-3"
        aria-label={ctx.t("execution.title")}
      >
        <div class="flex items-center gap-2 text-13-regular">
          <Show when={working()}>
            <Spinner />
          </Show>
          <span class="flex-1">{ctx.t(`browse.state.${state.value?.thread.state ?? "unknown"}`)}</span>
          <Show when={state.value?.thread.state === "running" && state.value.turn?.state === "running"}>
            <ctx.ui.Button
              size="small"
              variant="ghost"
              disabled={queue.busy()}
              busy={state.controlling}
              onClick={() => {
                const turn = state.value?.turn

                if (!turn || turn.state !== "running" || state.value?.thread.state !== "running") return
                void control({ action: "interrupt", threadID: props.threadRef.threadID, turnID: turn.id })
              }}
            >
              {ctx.t("execution.stop")}
            </ctx.ui.Button>
          </Show>
          <ctx.ui.Button
            size="small"
            variant="ghost"
            disabled={!state.connected || state.controlling}
            busy={state.reading}
            onClick={() => {
              setState("error", undefined)

              if (state.supported) refresh()
              else inspect()
            }}
          >
            {ctx.t("execution.refresh")}
          </ctx.ui.Button>
        </div>
        <Show when={!state.connected}>
          <p class="text-13-regular text-v2-text-text-muted">{ctx.t("browse.offline")}</p>
        </Show>
        <Show when={state.error}>
          {(error) => (
            <p role="alert" class="text-13-regular">
              {ctx.t(`execution.${error()}`)}
            </p>
          )}
        </Show>
        <Show when={state.value?.nextCursor}>
          <p class="text-13-regular text-v2-text-text-muted">{ctx.t("execution.partial")}</p>
        </Show>
        <ctx.ui.QueuePanel queue={queue} />
      </section>
      <ctx.ui.BackendComposer
        server={props.serverID}
        threadRef={props.threadRef}
        available={state.connected && state.supported}
        send={(input) => {
          const server = props.serverRef()

          if (!server?.connected || !server.compatible || !state.supported)
            return Promise.reject(new Error("Backend unavailable"))

          return server.client.rpc(ConversationBackend.Api).send(input)
        }}
        onAccepted={() => {
          refresh()
          props.onAccepted?.()
        }}
      />
    </Show>
  )
}
