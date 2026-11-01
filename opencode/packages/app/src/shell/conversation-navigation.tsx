import { A, useLocation } from "@solidjs/router"
import { Icon } from "@opencode/ui/icon"
import { Tooltip } from "@opencode/ui/tooltip"
import { useLanguage } from "@/runtime/i18n/language"
import { useSettingsSurface } from "@/settings/surface"

/** Product navigation only. Native settings and route owners perform each transition. */
export function ConversationNavigation() {
  const language = useLanguage()
  const location = useLocation()
  const settings = useSettingsSurface()
  const current = (id: string) => settings.active() && settings.view().tab === id

  return (
    <nav data-component="application-navigation" aria-label={language.t("assistant.navigation")}>
      <Tooltip value={language.t("home.title")} placement="right">
        <A
          href="/"
          class="assistant-nav-action"
          aria-label={language.t("home.title")}
          aria-current={location.pathname === "/" && !settings.active() ? "page" : undefined}
        >
          <Icon name="grid-plus" size="large" />
        </A>
      </Tooltip>
      <Tooltip value={language.t("assistant.modules")} placement="right">
        <button
          type="button"
          class="assistant-nav-action"
          aria-label={language.t("assistant.modules")}
          aria-pressed={current("application-modules")}
          disabled={!settings.plugins.tabs().has("application-modules")}
          onClick={() => settings.select("application-modules")}
        >
          <Icon name="cube" size="large" />
        </button>
      </Tooltip>
      <Tooltip value={language.t("assistant.notifications")} placement="right">
        <button
          type="button"
          class="assistant-nav-action"
          aria-label={language.t("assistant.notifications")}
          aria-pressed={current("module-notifications")}
          disabled={!settings.plugins.tabs().has("module-notifications")}
          onClick={() => settings.select("module-notifications")}
        >
          <Icon name="notifications" size="large" />
        </button>
      </Tooltip>
      <div class="assistant-nav-bottom">
        <Tooltip value={language.t("command.settings.open")} placement="right">
          <button
            type="button"
            class="assistant-nav-action"
            aria-label={language.t("command.settings.open")}
            aria-pressed={settings.active() && !current("application-modules") && !current("module-notifications")}
            onClick={() => settings.open()}
          >
            <Icon name="settings-gear" size="large" />
          </button>
        </Tooltip>
      </div>
    </nav>
  )
}
