import { A, useLocation } from "@solidjs/router"
import { For } from "solid-js"
import { Icon } from "@opencode/ui/icon"
import { Tooltip } from "@opencode/ui/tooltip"
import { useLanguage } from "@/runtime/i18n/language"
import { useSettingsSurface } from "@/settings/surface"
import { applicationPagePath, createApplicationPages } from "@/runtime/plugin/application-pages"

/** Application pages and native conversations are peers; settings keeps configuration. */
export function ConversationNavigation() {
  const language = useLanguage()
  const location = useLocation()
  const settings = useSettingsSurface()
  const registry = createApplicationPages()
  const current = (path: string) => (location.pathname === path ? ("page" as const) : undefined)

  const conversations = () =>
    location.pathname === "/conversations" ||
    location.pathname.startsWith("/server/") ||
    location.pathname === "/new-session"

  return (
    <nav data-component="application-navigation" aria-label={language.t("assistant.navigation")}>
      <Tooltip value={registry.home()?.value.title ?? language.t("assistant.overview")} placement="right">
        <A
          href="/"
          class="assistant-nav-action"
          aria-label={registry.home()?.value.title ?? language.t("assistant.overview")}
          aria-current={current("/")}
        >
          <Icon name="grid-plus" size="large" />
        </A>
      </Tooltip>
      <Tooltip value={language.t("assistant.conversations")} placement="right">
        <A
          href="/conversations"
          class="assistant-nav-action"
          aria-label={language.t("assistant.conversations")}
          aria-current={conversations() ? "page" : undefined}
        >
          <Icon name="speech-bubble" size="large" />
        </A>
      </Tooltip>
      <div class="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto" data-scrollable>
        <For each={registry.pages().filter((item) => !item.value.home)}>
          {(item) => (
            <Tooltip value={item.value.title} placement="right">
              <A
                href={applicationPagePath(item.plugin, item.value.id)}
                class="assistant-nav-action"
                aria-label={item.value.title}
                aria-current={current(applicationPagePath(item.plugin, item.value.id))}
              >
                <Icon name={item.value.icon ?? "cube"} size="large" />
              </A>
            </Tooltip>
          )}
        </For>
      </div>
      <div class="assistant-nav-bottom">
        <Tooltip value={language.t("command.settings.open")} placement="right">
          <button
            type="button"
            class="assistant-nav-action"
            aria-label={language.t("command.settings.open")}
            aria-pressed={settings.active()}
            onClick={() => settings.open()}
          >
            <Icon name="settings-gear" size="large" />
          </button>
        </Tooltip>
      </div>
    </nav>
  )
}
