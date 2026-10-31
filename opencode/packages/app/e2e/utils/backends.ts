import type { OpenCodeEvent } from "@opencode/client/promise"
import { ConversationBackend } from "@opencode/schema/conversation-backend"
import { Schema } from "effect"
import type { MockServerConfig } from "./mock-server"

type Fixture = {
  list: () => readonly ConversationBackend.Descriptor[] | Promise<readonly ConversationBackend.Descriptor[]>
  status: (backendID: string) => ConversationBackend.Status | Promise<ConversationBackend.Status>
  login?: (backendID: string) => ConversationBackend.BrowserLogin | Promise<ConversationBackend.BrowserLogin>
  cancel?: (backendID: string, loginID: string) => "canceled" | "not-found"
}

// Backend methods share the real client's RPC envelope. All unconfigured mutations fail the scenario.
export function backendRpc(fixture: Fixture): NonNullable<MockServerConfig["rpc"]> {
  return async ({ id, method, body }) => {
    if (id !== ConversationBackend.Api.id) throw new Error(`Unexpected RPC: ${id}.${method}`)

    if (method === "list") return [...(await fixture.list())]

    const input = Schema.decodeUnknownSync(Schema.Struct({ backendID: Schema.String }))(body)

    if (method === "status") return fixture.status(input.backendID)

    if (method === "login" && fixture.login) return fixture.login(input.backendID)

    if (method === "cancelLogin" && fixture.cancel) {
      const cancel = Schema.decodeUnknownSync(Schema.Struct({ loginID: Schema.String }))(body)

      return fixture.cancel(input.backendID, cancel.loginID)
    }

    throw new Error(`Unexpected mutation: ${method}`)
  }
}

export function backendEvent(
  name: "changed" | "authentication",
  data: Schema.JsonObject,
  directory: string,
): OpenCodeEvent {
  return {
    id: `evt_backend_${name}`,
    created: Date.now(),
    type: `rpc.experimental.conversation.${name}`,
    location: { directory },
    data,
  }
}
