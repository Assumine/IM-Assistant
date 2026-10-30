import { Button } from "@opencode/ui/button"
import { Loader } from "@opencode/ui/loader"
import { TextField } from "@opencode/ui/text-field"
import { Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { useServerSDK } from "@/runtime/server/client"

// Only connection metadata goes here. The existing provider dialog owns keys and accounts.
export function ProviderConnectionForm(props: { onCreated: (id: string) => void; onCancel: () => void }) {
  const language = useLanguage()
  const sdk = useServerSDK()
  const [state, setState] = createStore({
    id: "",
    name: "",
    baseURL: "",
    model: "",
    context: "",
    output: "",
    saving: false,
    failed: false,
  })
  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (state.saving) return
    setState({ saving: true, failed: false })
    await sdk.api.experimental.config.provider
      .create({
        id: state.id.trim(),
        name: state.name.trim(),
        baseURL: state.baseURL.trim(),
        models: [{ id: state.model.trim(), context: Number(state.context), output: Number(state.output) }],
      })
      .then(() => props.onCreated(state.id.trim()))
      .catch(() => setState({ failed: true, saving: false }))
  }
  return (
    <form class="settings-section rounded-lg border border-v2-border-border-muted p-4" onSubmit={submit}>
      <h3 class="settings-section-title">{language.t("settings.providers.connection.add")}</h3>
      <p class="text-13-regular text-v2-text-text-muted">{language.t("settings.providers.connection.description")}</p>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TextField
          label={language.t("settings.providers.connection.id")}
          value={state.id}
          required
          pattern="[a-z][a-z0-9-]{0,63}"
          maxLength={64}
          disabled={state.saving}
          onChange={(value) => setState("id", value)}
        />
        <TextField
          label={language.t("settings.providers.connection.name")}
          value={state.name}
          required
          maxLength={100}
          disabled={state.saving}
          onChange={(value) => setState("name", value)}
        />
        <TextField
          label={language.t("settings.providers.connection.url")}
          value={state.baseURL}
          required
          type="url"
          placeholder="https://api.example.com/v1"
          disabled={state.saving}
          onChange={(value) => setState("baseURL", value)}
        />
        <TextField
          label={language.t("settings.providers.connection.model")}
          value={state.model}
          required
          maxLength={256}
          disabled={state.saving}
          onChange={(value) => setState("model", value)}
        />
        <TextField
          label={language.t("settings.providers.connection.context")}
          value={state.context}
          required
          type="number"
          min="1"
          step="1"
          disabled={state.saving}
          onChange={(value) => setState("context", value)}
        />
        <TextField
          label={language.t("settings.providers.connection.output")}
          value={state.output}
          required
          type="number"
          min="1"
          step="1"
          disabled={state.saving}
          onChange={(value) => setState("output", value)}
        />
      </div>
      <Show when={state.failed}>
        <p role="alert" class="text-13-regular">
          {language.t("settings.providers.connection.failed")}
        </p>
      </Show>
      <div class="flex items-center gap-2">
        <Button type="submit" variant="neutral" disabled={state.saving}>
          <Show when={state.saving}>
            <Loader />
          </Show>
          {language.t("settings.providers.connection.save")}
        </Button>
        <Button type="button" variant="ghost" disabled={state.saving} onClick={props.onCancel}>
          {language.t("common.cancel")}
        </Button>
      </div>
    </form>
  )
}
