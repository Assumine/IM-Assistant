import { Show, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { Option, Schema } from "effect"
import type { UiBackendQuestionProps } from "@opencode/plugin/gui"
import type { FormAnswer } from "@opencode/client/promise"
import { useLanguage } from "@/runtime/i18n/language"
import { useSettings } from "@/settings/model"
import { QuestionDockClassic } from "./session-question-dock-classic"
import { QuestionDockExperimental } from "./session-question-dock-experimental"

const TextAnswers = Schema.Record(Schema.String, Schema.String)

export default function BackendQuestion(props: UiBackendQuestionProps) {
  const settings = useSettings()
  const language = useLanguage()

  return (
    <Show when={props.question?.id} keyed>
      {(id) => {
        const original = props.question!
        const threadID = props.threadRef.threadID
        const [state, setState] = createStore({ settled: false })
        let disposed = false
        onCleanup(() => {
          disposed = true
        })

        const request = {
          id,
          fields: original.prompts.map((prompt) => ({
            type: "string" as const,
            key: prompt.id,
            title: prompt.header,
            description: prompt.question,
            options: prompt.options.map((option) => ({
              value: option.label,
              label: option.label,
              description: option.description,
            })),
            custom: prompt.other,
            required: true,
          })),
        }

        const respond = async (answer?: FormAnswer) => {
          if (props.busy || state.settled || props.question?.id !== id || props.question.state !== "pending")
            throw new Error(language.t("backend.question.unavailable"))

          const values =
            answer === undefined
              ? undefined
              : Option.getOrThrowWith(
                  Schema.decodeUnknownOption(TextAnswers)(answer),
                  () => new Error(language.t("backend.question.incomplete")),
                )

          const answers = Object.fromEntries(
            original.prompts.map((prompt) => {
              const value = values?.[prompt.id]

              if (values && !value?.trim()) throw new Error(language.t("backend.question.incomplete"))

              return [prompt.id, value ? [value] : []]
            }),
          )

          const result = await props
            .control(
              answer === undefined
                ? { action: "dismiss-question", threadID, questionID: id }
                : { action: "answer", threadID, questionID: id, answers },
            )
            .catch(() => {
              throw new Error(language.t("backend.question.unknown"))
            })

          if (result.status !== "resolved" && result.status !== "not-found")
            throw new Error(language.t("backend.question.unknown"))

          if (!disposed) setState("settled", true)
        }

        const presentation = {
          request,
          cacheKey: JSON.stringify(["whole-backend-question", props.server, props.threadRef.backendID, threadID, id]),
          reply: (answer: FormAnswer) => respond(answer),
          reject: () => respond(),
          onSubmit: () => {},
          requireAnswers: true,
          retainDraft: () => props.question?.id === id,
          get disabled() {
            return props.busy || state.settled || props.question?.state !== "pending"
          },
        }

        return (
          <Show when={settings.general.newQuestionUI()} fallback={<QuestionDockClassic {...presentation} />}>
            <QuestionDockExperimental {...presentation} />
          </Show>
        )
      }}
    </Show>
  )
}
