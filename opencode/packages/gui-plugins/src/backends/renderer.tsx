import { lazy, onCleanup, Suspense } from "solid-js"
import { BackendView, SettingsPage, type Plugin } from "@opencode/plugin/gui"
import { Loader } from "@opencode/ui/loader"
import { onIdle } from "@opencode/plugin/gui/builtin"
import type definition from "./index"

const setup: Plugin.Setup<typeof definition> = (ctx) => {
  const Page = lazy(() => import("./page"))
  const Room = lazy(() => import("./room"))
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
