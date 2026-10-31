import { usePlugin, type BackendViewProps } from "@opencode/plugin/gui"
import { ConversationBrowser } from "./browser"
import type definition from "./index"

/** The read-only main surface shares the browser's history reader; it never creates a Session or resumes a thread. */
export default function Room(props: BackendViewProps) {
  const ctx = usePlugin<typeof definition>()
  const server = () => ctx.servers.get(props.server)

  return (
    <ConversationBrowser
      embedded
      server={server}
      backend={{ id: props.ref.backendID, label: props.title }}
      thread={{ ref: props.ref, title: props.title, state: "unknown" }}
      onThread={(thread) => ctx.tabs.openBackend({ server: props.server, ref: thread.ref, title: thread.title })}
    />
  )
}
