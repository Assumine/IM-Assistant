import { usePlugin, type BackendViewProps } from "@opencode/plugin/gui"
import { createStore } from "solid-js/store"
import { ConversationBrowser } from "./browser"
import { Execution } from "./execution"
import type definition from "./index"

/** History and queue remain backend-owned. Opening a tab does not create a Session or resume a thread. */
export default function Room(props: BackendViewProps) {
  const ctx = usePlugin<typeof definition>()
  const server = () => ctx.servers.get(props.server)
  const [state, setState] = createStore({ revision: 0 })

  return (
    <div class="flex size-full min-h-0 flex-col">
      <div class="flex min-h-0 flex-1 flex-col">
        <ConversationBrowser
          embedded
          revision={state.revision}
          server={server}
          backend={{ id: props.ref.backendID, label: props.title }}
          thread={{ ref: props.ref, title: props.title, state: "unknown" }}
          onThread={(thread) => ctx.tabs.openBackend({ server: props.server, ref: thread.ref, title: thread.title })}
        />
      </div>
      <Execution
        serverID={props.server}
        threadRef={props.ref}
        serverRef={server}
        onAccepted={() => setState("revision", (value) => value + 1)}
      />
    </div>
  )
}
