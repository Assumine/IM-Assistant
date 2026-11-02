import { createMemo, lazy, onCleanup, Suspense } from "solid-js"
import { createStore } from "solid-js/store"
import { ApplicationPage, Command, createKeyed, SettingsPage, Style, type Plugin } from "@opencode/plugin/gui"
import { Loader } from "@opencode/ui/loader"
import type { Capability } from "@opencode/schema/capability"
import type { WorkspaceCatalog } from "./workspace"
import type definition from "./index"
import css from "./workspace.css?inline"

const setup: Plugin.Setup<typeof definition> = (ctx) => {
  const Page = lazy(() => import("./page"))
  const Workspace = lazy(() => import("./workspace"))
  const [data, setData] = createStore<WorkspaceCatalog>({ modules: [], phase: "loading" })

  const server = createMemo(() => {
    const list = ctx.servers.list().flatMap((id) => ctx.servers.get(id) ?? [])

    return list.find((item) => item.builtin) ?? list[0]
  })

  const label = (item: Capability.Info) => {
    if (item.id === "downloads") return ctx.t("workspace.downloads")

    if (item.id === "research") return ctx.t("workspace.research")

    if (item.id === "qq-portal") return ctx.t("workspace.qq")

    if (item.id === "qq-chatbot") return ctx.t("workspace.chatbot")

    return item.title
  }

  const icon = (item: Capability.Info): NonNullable<ApplicationPage["icon"]> => {
    if (item.id === "downloads") return "download"

    if (item.id === "research") return "flask"

    if (item.id === "qq-portal") return "speech-bubble"

    if (item.id === "qq-chatbot") return "bubble-5"

    return "cube"
  }

  ctx.add(Style, css)
  ctx.add(ApplicationPage, {
    id: "overview",
    home: true,
    order: -100,
    icon: "grid-plus",
    get title() {
      return ctx.t("workspace.overview")
    },
    render: () => (
      <Suspense fallback={<Loader />}>
        <Workspace data={data} server={server()} label={label} icon={icon} />
      </Suspense>
    ),
  })

  // One event-driven directory read feeds navigation; it never starts business services or AI work.
  createKeyed(
    () => (ctx.app.workspace === false && server()?.connected && server()?.compatible ? server()?.client : undefined),
    (client) => {
      const controller = new AbortController()
      let revision = 0

      const read = async () => {
        const current = ++revision

        try {
          const { Capability } = await import("@opencode/schema/capability")

          if (controller.signal.aborted) return
          const rpc = client.rpc(Capability.Api)
          const modules = await rpc.list({}, { signal: controller.signal })

          if (!controller.signal.aborted && current === revision) setData({ modules, phase: "ready" })
        } catch {
          if (!controller.signal.aborted && current === revision) setData("phase", "failed")
        }
      }

      void import("@opencode/schema/capability").then(({ Capability }) => {
        if (controller.signal.aborted) return
        const off = client.rpc(Capability.Api).events.on("changed", () => void read(), { signal: controller.signal })
        controller.signal.addEventListener("abort", off, { once: true })
      })
      onCleanup(() => controller.abort())
      void read()
    },
    { otherwise: () => setData("phase", "offline") },
  )

  createKeyed(
    () => data.modules.map((item) => item.id).join("|"),
    () => {
      for (const [index, item] of data.modules.entries()) {
        ctx.add(ApplicationPage, {
          id: "module-" + item.id,
          order: index,
          icon: icon(item),
          get title() {
            return label(item)
          },
          render: () => (
            <Suspense fallback={<Loader />}>
              <Workspace
                data={data}
                server={server()}
                moduleID={item.id}
                title={label(item)}
                label={label}
                icon={icon}
              />
            </Suspense>
          ),
        })
      }
    },
  )

  for (const view of ["modules", "messages"] as const) {
    const id = view === "modules" ? "application-modules" : "module-notifications"
    ctx.add(Command, () => ({ id: view, title: ctx.t(view), run: () => ctx.layout.page(view) }))
    ctx.add(ApplicationPage, {
      id: view,
      order: view === "modules" ? 90 : 80,
      icon: view === "modules" ? "cube" : "notifications",
      get title() {
        return ctx.t(view)
      },
      render: () => (
        <Suspense fallback={<Loader />}>
          <Page view={view} standalone />
        </Suspense>
      ),
    })
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
}

export default setup
