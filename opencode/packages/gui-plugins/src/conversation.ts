import type { Entry } from "@opencode/plugin/gui/host"

// Native conversation displays have no project, process or arbitrary plugin-code bridge.
export function conversation(entries: readonly Entry[]) {
  return entries.filter((entry) => ["context", "btw", "details", "backends"].includes(entry.id))
}
