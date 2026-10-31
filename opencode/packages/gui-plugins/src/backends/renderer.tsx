import { lazy, onCleanup, Suspense } from "solid-js"
import { SettingsPage, type Plugin } from "@opencode/plugin/gui"
import { onIdle } from "@opencode/plugin/gui/builtin"
import type definition from "./index"

const setup: Plugin.Setup<typeof definition> = (ctx) => {
  const Page = lazy(() => import("./page"))
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
