import { lazy, onCleanup, Show, Suspense } from "solid-js"
import { BackendView, SettingsPage, Slot, type Plugin } from "@opencode/plugin/gui"
import { Loader } from "@opencode/ui/loader"
import { onIdle } from "@opencode/plugin/gui/builtin"
import type definition from "./index"

const setup: Plugin.Setup<typeof definition> = (ctx) => {
  const Page = lazy(() => import("./page"))
  const Room = lazy(() => import("./room"))
  const Launcher = lazy(() => import("./launcher"))
  const Home = lazy(() => import("./home"))
  ctx.add(Slot, {
    at: "home.sessions.before",
    render: (input) => (
      <Show when={input.server} keyed>
        {(server) => (
          // Only this contribution waits for its first chunk; the native Home list remains mounted.
          <Suspense
            fallback={
              <section class="py-2 pr-3">
                <ctx.ui.Button variant="ghost" size="small" disabled>
                  {ctx.t("home.title")}
                </ctx.ui.Button>
              </section>
            }
          >
            <Home server={server} />
          </Suspense>
        )}
      </Show>
    ),
  })
  ctx.add(Slot, {
    at: "new-session.actions",
    render: (input) => (
      <ctx.ui.Button
        variant="ghost"
        size="small"
        onClick={() => {
          const dialog = ctx.dialogs.open(() => (
            <Suspense
              fallback={
                <ctx.ui.Dialog title={ctx.t("launch.title")}>
                  <Loader />
                </ctx.ui.Dialog>
              }
            >
              <Launcher server={input.server} close={() => dialog.close()} />
            </Suspense>
          ))
        }}
      >
        {ctx.t("launch.open")}
      </ctx.ui.Button>
    ),
  })
  ctx.add(BackendView, {
    render: (props) => (
      <Suspense
        fallback={
          <div role="status" class="m-auto">
            <Loader />
          </div>
        }
      >
        <Room {...props} />
      </Suspense>
    ),
  })
  onCleanup(onIdle(() => void Page.preload()))
  ctx.add(SettingsPage, {
    id: "conversation-backends",
    icon: "server",
    get title() {
      return ctx.t("title")
    },
    get entries() {
      return [{ id: "conversation-backends", title: ctx.t("title"), keywords: "backend account login connection" }]
    },
    render: () => (
      <Suspense>
        <Page />
      </Suspense>
    ),
  })
}

export default setup
