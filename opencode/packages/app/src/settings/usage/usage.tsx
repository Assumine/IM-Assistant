import type { SessionStatsInfo } from "@opencode/client/promise"
import { Button } from "@opencode/ui/button"
import { Loader } from "@opencode/ui/loader"
import { createEffect, on, onCleanup, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { useServerSDK } from "@/runtime/server/client"
import { SettingsList } from "../list"

type Period = "today" | "week" | "all"

export function SettingsUsage(props: { active: boolean; headerAction?: JSX.Element }) {
  const language = useLanguage()
  const sdk = useServerSDK()
  const [state, setState] = createStore<{ period: Period; refresh: number; loading: boolean; error: boolean;
    latest?: { period: Period; result: SessionStatsInfo } }>({ period: "today", refresh: 0, loading: false, error: false })
  createEffect(on([() => props.active, () => state.period, () => state.refresh], ([active, period]) => {
    if (!active) return
    let stale = false
    onCleanup(() => { stale = true })
    setState({ loading: true, error: false })
    const now = new Date()
    const start = new Date(now)
    start.setHours(0, 0, 0, 0)
    if (period === "week") start.setDate(start.getDate() - 6)
    void sdk.api.experimental.session.stats({ from: period === "all" ? undefined : start.getTime(),
      to: now.getTime() + 1, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, tools: "none" })
      .then(result => { if (!stale) setState({ latest: { period, result }, loading: false }) })
      .catch(() => { if (!stale) setState({ error: true, loading: false }) })
  }))
  const data = () => state.latest?.period === state.period ? state.latest.result : undefined
  const reporting = () => data()?.reporting
  const number = (value: number | undefined) => value === undefined ? language.t("settings.usage.unknown") : value.toLocaleString()
  const field = (name: "input" | "output" | "reasoning" | "cacheRead" | "cacheWrite", value: number | undefined) => {
    const report = reporting()
    return report && report.records > 0 && report.fields[name] === report.records ? number(value) : language.t("settings.usage.unknown")
  }
  const rate = () => {
    const result = data()
    const report = reporting()
    if (!result || !report?.records || [report.fields.input, report.fields.cacheRead, report.fields.cacheWrite].some(count => count !== report.records)) return
    const total = result.tokens.input + result.tokens.cache.read + result.tokens.cache.write
    return total > 0 ? (result.tokens.cache.read / total).toLocaleString(undefined, { style: "percent", maximumFractionDigits: 1 }) : undefined
  }
  const money = (value: number | undefined) => value === undefined ? language.t("settings.usage.unknown")
    : value.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 6 })
  const metric = (title: string, value: JSX.Element, hint?: string) => <div class="min-w-0">
    <dt class="text-13-regular text-v2-text-text-muted" title={hint}>{title}</dt>
    <dd class="mt-1 text-lg font-medium leading-7 tabular-nums text-v2-text-text-base">{value}</dd>
  </div>

  return <>
    <div class="settings-tab-header"><div class="settings-tab-header-row">
      <div class="flex flex-col gap-1"><h2 class="settings-tab-title">{language.t("settings.usage.title")}</h2>
        <p class="text-13-regular text-v2-text-text-muted">{language.t("settings.usage.description")}</p></div>
      <div class="settings-tab-header-actions">{props.headerAction}</div>
    </div></div>
    <div class="settings-tab-body settings-tab-body--sectioned">
      <div class="flex flex-wrap items-center gap-2" role="group" aria-label={language.t("settings.usage.range")}>
        {(["today", "week", "all"] as const).map(period => <Button size="small" variant={state.period === period ? "neutral" : "outline"}
          aria-pressed={state.period === period} onClick={() => setState("period", period)}>{language.t(`settings.usage.${period}`)}</Button>)}
        <Button size="small" variant="ghost" disabled={state.loading} onClick={() => setState("refresh", value => value + 1)}>{language.t("settings.usage.refresh")}</Button>
      </div>
      <Show when={state.loading}><div role="status" class="flex items-center gap-2 text-13-regular"><Loader />{language.t("settings.usage.loading")}</div></Show>
      <Show when={state.error}><p role="alert">{language.t("settings.usage.failed")}</p></Show>
      <Show when={data()}>{result => <>
        <Show when={(reporting()?.records ?? result().steps) === 0}><p>{language.t("settings.usage.empty")}</p></Show>
        <SettingsList>
          <dl class="grid grid-cols-1 gap-4 py-4 sm:grid-cols-3">
            {metric(language.t("settings.usage.tokens"), number(result().tokens.input + result().tokens.output + result().tokens.reasoning + result().tokens.cache.read + result().tokens.cache.write), language.t("settings.usage.tokensHint"))}
            {metric(language.t("settings.usage.cacheHit"), rate() ?? language.t("settings.usage.unknown"), language.t("settings.usage.cacheHint"))}
            {metric(language.t("settings.usage.coverage"), reporting() ? language.plural("settings.usage.coverageValue", reporting()!.records, { reported: reporting()!.complete, total: reporting()!.records }) : language.t("settings.usage.unknown"))}
          </dl>
          <p class="pb-4 text-13-regular text-v2-text-text-muted">{language.t("settings.usage.coverageHint")}</p>
          <dl class="grid grid-cols-2 gap-4 border-t border-v2-border-border-base py-4 sm:grid-cols-3">
            {metric(language.t("settings.usage.input"), field("input", result().tokens.input))}
            {metric(language.t("settings.usage.output"), field("output", result().tokens.output))}
            {metric(language.t("settings.usage.reasoning"), field("reasoning", result().tokens.reasoning))}
            {metric(language.t("settings.usage.cacheRead"), field("cacheRead", result().tokens.cache.read))}
            {metric(language.t("settings.usage.cacheWrite"), field("cacheWrite", result().tokens.cache.write))}
          </dl>
        </SettingsList>
        <section class="settings-section"><p class="text-13-regular text-v2-text-text-muted">{language.t("settings.usage.costHint")}</p>
          <SettingsList>
            <dl class="grid grid-cols-1 gap-4 py-4 sm:grid-cols-3">
              {metric(language.t("settings.usage.reportedCost"), money(reporting()?.cost.reported.records ? reporting()!.cost.reported.amount : undefined))}
              {metric(language.t("settings.usage.estimatedCost"), money(reporting()?.cost.catalog.records ? reporting()!.cost.catalog.amount : undefined))}
              {metric(language.t("settings.usage.unclassifiedCost"), money(reporting() && (reporting()!.cost.unknown.records + reporting()!.cost.mixed.records > 0) ? reporting()!.cost.unknown.amount + reporting()!.cost.mixed.amount : undefined))}
            </dl>
          </SettingsList>
        </section>
      </>}</Show>
    </div>
  </>
}
