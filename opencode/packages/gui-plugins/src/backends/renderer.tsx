import { lazy, onCleanup, Suspense } from "solid-js"
import { BackendView, SettingsPage, Slot, type Plugin } from "@opencode/plugin/gui"
import { Loader } from "@opencode/ui/loader"
import { onIdle } from "@opencode/plugin/gui/builtin"
import type definition from "./index"

const setup: Plugin.Setup<typeof definition> = (ctx) => {
  const Page = lazy(() => import("./page"))
  const Room = lazy(() => import("./room"))
  const Launcher = lazy(() => import("./launcher"))
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
