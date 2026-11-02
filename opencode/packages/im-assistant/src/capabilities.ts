export * as Capabilities from "./capabilities.js"

import type { ApplicationModuleEntry } from "@opencode/plugin/promise/application"
import { Portals } from "./portals.js"
import { Chatbots } from "./chatbots.js"
import { Research } from "./research.js"

/** Product composition only: metadata is visible even while optional configuration is disabled or failing. */
export function load(): readonly ApplicationModuleEntry[] {
  return [
    {
      id: "qq-portal",
      title: "QQ task forwarding",
      async load(signal) {
        const modules = await Portals.load()
        return signal.aborted ? undefined : modules[0]
      },
    },
    {
      id: "qq-chatbot",
      title: "QQ chat companion",
      settings: Chatbots.settings(),
      async load(signal) {
        const module = await Chatbots.load()
        return signal.aborted ? undefined : module
      },
    },
    {
      id: "research", title: "Research", settings: Research.settings(),
      async load(signal) { const module = await Research.load(); return signal.aborted ? undefined : module },
    },
  ]
}
