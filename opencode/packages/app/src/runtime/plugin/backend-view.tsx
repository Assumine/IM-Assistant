import { createMemo, Show } from "solid-js"
import { BackendView } from "@opencode/plugin/gui"
import { useCurrentRoute } from "@/shell/state/layout"
import { useTabs } from "@/shell/tabs/tabs"
import { useLanguage } from "@/runtime/i18n/language"
import { SessionPanelFrame, SessionRouteFrame } from "@/session/session-frame"
import { usePluginHost } from "./host"
import { Contribution } from "./render"

/** The shell owns the tab; a contribution renders its original backend reference without a Session/Inbox. */
export default function BackendRoute() {
  const route = useCurrentRoute()
  const host = usePluginHost()
  const tabs = useTabs()
  const language = useLanguage()

  const target = createMemo(() => {
    const current = route()

    return current.type === "backend" ? current : undefined
  })

  const identity = () => {
    const value = target()

    return value && JSON.stringify([value.server, value.ref])
  }

  return (
    <SessionRouteFrame padded>
      <SessionPanelFrame raised>
        <Show when={identity()} keyed>
          {(_identity) => {
            const thread = target()

            if (!thread) return null

            const renderer = createMemo(() => {
              const items = host.items(BackendView)

              return (
                items.find((item) => item.value.backendID === thread.ref.backendID) ??
                items.find((item) => item.value.backendID === undefined)
              )
            })

            const title = () => {
              const tab = tabs.store.find(
                (tab) =>
                  tab.type === "backend" &&
                  tab.server === thread.server &&
                  tab.ref.backendID === thread.ref.backendID &&
                  tab.ref.threadID === thread.ref.threadID,
              )

              return tab?.type === "backend" ? tab.title : thread.ref.threadID
            }

            return (
              <Show
                when={renderer()}
                keyed
                fallback={
                  <p role="alert" class="m-auto p-6 text-13-regular">
                    {language.t("backend.view.unavailable")}
                  </p>
                }
              >
                {(item) => (
                  <Contribution plugin={item.plugin}>
                    {() =>
                      item.value.render({
                        server: thread.server,
                        ref: thread.ref,
                        get title() {
                          return title()
                        },
                      })
                    }
                  </Contribution>
                )}
              </Show>
            )
          }}
        </Show>
      </SessionPanelFrame>
    </SessionRouteFrame>
  )
}
