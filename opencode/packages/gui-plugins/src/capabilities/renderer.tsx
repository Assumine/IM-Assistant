import { lazy, Suspense } from "solid-js"
import { Command, SettingsPage, Slot, type Plugin } from "@opencode/plugin/gui"
import { Loader } from "@opencode/ui/loader"
import type definition from "./index"

const setup: Plugin.Setup<typeof definition> = (ctx) => {
  const Page = lazy(() => import("./page"))

  for (const view of ["modules", "messages"] as const) {
    const id = view === "modules" ? "application-modules" : "module-notifications"
    ctx.add(Command, () => ({ id: view, title: ctx.t(view), run: () => ctx.layout.settings(id) }))
    ctx.add(SettingsPage, {
      id,
      icon: view === "modules" ? "cube" : "notifications",
      get title() {
        return ctx.t(view)
      },
      get entries() {
        return [{ id, title: ctx.t(view), keywords: "module service notification monitor unread" }]
      },
      render: () => (
        <Suspense
          fallback={
            <div class="settings-tab-body" role="status">
              <Loader />
            </div>
          }
        >
          <Page view={view} />
        </Suspense>
      ),
    })
  }

  ctx.add(Slot, {
    at: "home.sessions.before",
    render: () => (
      <div class="flex gap-2 py-2">
        <ctx.ui.Button variant="ghost" size="small" onClick={() => ctx.layout.settings("application-modules")}>
          {ctx.t("modules")}
        </ctx.ui.Button>
        <ctx.ui.Button variant="ghost" size="small" onClick={() => ctx.layout.settings("module-notifications")}>
          {ctx.t("messages")}
        </ctx.ui.Button>
      </div>
    ),
  })
}

export default setup
