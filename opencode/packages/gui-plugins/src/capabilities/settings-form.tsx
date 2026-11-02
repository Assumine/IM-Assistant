import { For, Show, createMemo } from "solid-js"
import { Predicate, Schema } from "effect"
import { Switch } from "@opencode/ui/switch"
import { usePlugin } from "@opencode/plugin/gui"
import type definition from "./index"

type Value = Schema.Schema.Type<typeof Schema.Json>

type Field = {
  id: string
  path: readonly string[]
  value: string | number | boolean
  kind: "string" | "number" | "boolean"
}

/** Parse bounded JSON data; do not infer missing values, discard fields or execute property paths. */
function fields(text: string): Field[] | undefined {
  try {
    const value = Schema.decodeUnknownSync(Schema.Json)(JSON.parse(text))
    const result: Field[] = []

    const visit = (value: Value, path: readonly string[], depth: number) => {
      if (depth > 12 || result.length >= 256) return

      if (Predicate.isString(value) || Predicate.isNumber(value) || Predicate.isBoolean(value)) {
        result.push({
          id: JSON.stringify(path),
          path,
          value,
          kind: Predicate.isBoolean(value) ? "boolean" : Predicate.isNumber(value) ? "number" : "string",
        })

        return
      }

      if (value !== null && !Predicate.isString(value) && !Predicate.isNumber(value) && !Predicate.isBoolean(value))
        for (const [key, entry] of Object.entries(value)) visit(entry, [...path, key], depth + 1)
    }

    visit(value, [], 0)

    return result
  } catch {
    return undefined
  }
}

export default function SettingsForm(props: { text: string; disabled: boolean; change: (text: string) => void }) {
  const ctx = usePlugin<typeof definition>()
  const entries = createMemo(() => fields(props.text))

  const label = (path: readonly string[]) =>
    path
      .map((part) => {
        if (part === "enabled") return ctx.t("form.enabled")

        if (part === "name") return ctx.t("form.name")

        if (part === "model") return ctx.t("form.model")

        if (part === "maxConcurrent") return ctx.t("form.maxConcurrent")

        if (part === "perDownloadLimit") return ctx.t("form.speed")

        if (part === "reserveBytes") return ctx.t("form.reserve")

        if (part === "enableDht") return ctx.t("form.dht")

        return /^\d+$/.test(part) ? String(Number(part) + 1) : part.replace(/([a-z])([A-Z])/g, "$1 $2")
      })
      .join(" / ")

  const change = (field: Field, value: Field["value"]) => {
    const root = Schema.decodeUnknownSync(Schema.Json)(JSON.parse(props.text))

    const replace = (current: Value, offset: number): Value => {
      if (offset === field.path.length) return value

      if (Array.isArray(current))
        return current.map((entry, index) =>
          String(index) === field.path[offset] ? replace(entry, offset + 1) : entry,
        )

      if (Predicate.isObject(current))
        return Object.fromEntries(
          Object.entries(current).map(([key, entry]) => [
            key,
            key === field.path[offset]
              ? replace(Schema.decodeUnknownSync(Schema.Json)(entry), offset + 1)
              : Schema.decodeUnknownSync(Schema.Json)(entry),
          ]),
        )

      return current
    }

    props.change(JSON.stringify(replace(root, 0), null, 2))
  }

  return (
    <div class="flex flex-col gap-4" aria-label={ctx.t("form.title")}>
      <Show
        when={entries()?.length}
        fallback={<p class="text-13-regular text-v2-text-text-muted">{ctx.t("form.advancedHint")}</p>}
      >
        <For each={entries()?.map((field) => field.id)}>
          {(id) => (
            <Show when={entries()?.find((field) => field.id === id)}>
              {(field) => (
                <Show
                  when={field().kind === "boolean"}
                  fallback={
                    <label class="flex flex-col gap-2 text-13-regular">
                      {label(field().path)}
                      <input
                        class="w-full rounded-md border border-v2-border-border-base bg-transparent px-3 py-2"
                        type={field().kind === "number" ? "number" : "text"}
                        step="any"
                        required={field().kind === "number"}
                        value={String(field().value)}
                        disabled={props.disabled}
                        onInput={(event) => {
                          if (field().kind === "number") {
                            if (event.currentTarget.value === "" || !Number.isFinite(event.currentTarget.valueAsNumber))
                              return
                            change(field(), event.currentTarget.valueAsNumber)
                          } else change(field(), event.currentTarget.value)
                        }}
                      />
                    </label>
                  }
                >
                  <Switch
                    checked={field().value === true}
                    disabled={props.disabled}
                    onChange={(value) => change(field(), value)}
                  >
                    {label(field().path)}
                  </Switch>
                </Show>
              )}
            </Show>
          )}
        </For>
      </Show>
      <p class="text-12-regular text-v2-text-text-muted">{ctx.t("form.advancedHint")}</p>
    </div>
  )
}
