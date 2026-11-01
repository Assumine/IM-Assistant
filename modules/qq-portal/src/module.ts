import type { ApplicationModule } from "../../../opencode/packages/plugin/src/promise/application"
import { ConversationBackend } from "../../../opencode/packages/schema/src/conversation-backend"
import { createPortal, openQQChannel, type ChannelOptions } from "./index"
import { readConfiguration } from "./configuration"

/** A complete application capability. Per-Location plugin setup never owns a bot connection. */
export async function configuredModule(home: string, environment: NodeJS.ProcessEnv = process.env, observe: {
  onState?: (botID: string, state: Parameters<NonNullable<ChannelOptions["onState"]>>[0]) => void
  onIssue?: ChannelOptions["onIssue"]
  onResult?: ChannelOptions["onResult"]
} = {}): Promise<ApplicationModule | undefined> {
  const config = await readConfiguration(home)
  if (!config.enabled) return undefined
  const accounts = config.accounts.map((account) => {
    const token = environment[account.tokenEnv] ?? ""
    delete environment[account.tokenEnv]
    return { ...account, token }
  })
  return {
    id: "qq-portal",
    open({ client, storage }) {
      const channels = accounts.map((account) => openQQChannel({
        policy: account.policy, connection: { url: account.url, token: account.token },
        portal: createPortal({ storage, session: client.session, backend: client.rpc(ConversationBackend.Api), policy: account.policy, controls: account.controls }),
        onResult: observe.onResult ?? (() => {}), onIssue: observe.onIssue,
        onState: (state) => observe.onState?.(account.policy.botID, state),
      }))
      return { close: async () => { await Promise.allSettled(channels.map((channel) => channel.close())) } }
    },
  }
}
