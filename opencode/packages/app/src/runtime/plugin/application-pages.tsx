import { A, useParams } from "@solidjs/router"
import { ApplicationPage } from "@opencode/plugin/gui"
import { createMemo, Show } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { usePluginHost } from "./host"
import { Contribution } from "./render"

export { applicationPagePath } from "./application-page-path"

export function createApplicationPages() {
  const host = usePluginHost()

  const pages = createMemo(() =>
    host.items(ApplicationPage).toSorted((a, b) => (a.value.order ?? 0) - (b.value.order ?? 0)),
  )

  return { pages, home: () => pages().find((item) => item.value.home) }
}

/** Full-size workspace; missing or failed providers never send the user into settings. */
export default function ApplicationPageView(props: { home?: boolean }) {
  const language = useLanguage()
  const params = useParams<{ plugin: string; page: string }>()
  const registry = createApplicationPages()

  const page = createMemo(() =>
    props.home
      ? registry.home()
      : registry.pages().find((item) => item.plugin === params.plugin && item.value.id === params.page),
  )

  return (
    <section
      data-component="application-page"
      class="flex-1 min-h-0 min-w-0 self-stretch overflow-auto bg-v2-background-bg-base"
      data-scrollable
    >
      <Show
        when={page()}
        keyed
        fallback={
          <div class="p-8 flex flex-col items-start gap-3" role="status">
            <p>{language.t("assistant.pageUnavailable")}</p>
            <A href="/conversations">{language.t("assistant.conversations")}</A>
          </div>
        }
      >
        {(item) => <Contribution plugin={item.plugin}>{() => item.value.render()}</Contribution>}
      </Show>
    </section>
  )
}
