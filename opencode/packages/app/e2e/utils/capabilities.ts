import { Capability } from "@opencode/schema/capability"
import { Schema } from "effect"
import type { OpenCodeEvent } from "@opencode/client/promise"
import type { MockServerConfig } from "./mock-server"
import type { Page } from "@playwright/test"

/** Simulate the browser visibility input; the product owns its listeners and timer cleanup. */
export async function capabilityVisibility(page: Page, hidden: boolean) {
  await page.evaluate((value) => {
    Object.defineProperty(document, "hidden", { configurable: true, value })
    document.dispatchEvent(new Event("visibilitychange"))
  }, hidden)
}

export function capabilityRpc(fixture: {
  list: () => readonly Capability.Info[]
  notifications?: (input: Capability.NoticeQuery) => Capability.NoticePage | Promise<Capability.NoticePage>
  markRead?: (input: Capability.NoticeRef) => Capability.Notice | Promise<Capability.Notice>
  stop?: (id: string) => Capability.Info | Promise<Capability.Info>
  metrics?: (id: string) => Capability.Metrics | Promise<Capability.Metrics>
  settings?: (id: string) => Capability.Settings | Promise<Capability.Settings>
  configure?: (input: { id: string; revision: string; text: string }) => Capability.Settings | Promise<Capability.Settings>
}): NonNullable<MockServerConfig["rpc"]> {
  return async ({ id, method, body }) => {
    if (id !== Capability.Api.id) throw new Error(`Unexpected RPC: ${id}.${method}`)

    if (method === "list") return [...fixture.list()]

    if (method === "notifications" && fixture.notifications)
      return fixture.notifications(Schema.decodeUnknownSync(Capability.NoticeQuery)(body))

    if (method === "markRead" && fixture.markRead)
      return fixture.markRead(Schema.decodeUnknownSync(Capability.NoticeRef)(body))
    const input = Schema.decodeUnknownSync(Schema.Struct({ id: Capability.ID }))(body)

    if (method === "stop" && fixture.stop) return fixture.stop(input.id)

    if (method === "metrics" && fixture.metrics) return fixture.metrics(input.id)

    if (method === "settings" && fixture.settings) return fixture.settings(input.id)

    if (method === "configure" && fixture.configure)
      return fixture.configure(Schema.decodeUnknownSync(Schema.Struct({ id: Capability.ID,
        revision: Capability.Settings.fields.revision, text: Capability.Settings.fields.text }))(body))
    throw new Error(`Unexpected capability operation: ${method}`)
  }
}

export function capabilityEvent(directory: string): OpenCodeEvent {
  return {
    id: "evt_capability_changed",
    created: Date.now(),
    type: "rpc.experimental.capability.changed",
    location: { directory },
    data: {},
  }
}
