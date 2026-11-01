import type { ApplicationModule } from "../../../opencode/packages/plugin/src/promise/application"
import { ConversationBackend } from "../../../opencode/packages/schema/src/conversation-backend"
import { createPortal, openQQChannel, type ChannelOptions } from "./index"
import { readConfiguration } from "./configuration"
import { createControlReplies } from "./notifications"
import { openTaskReplies } from "./task-replies"

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
      const channels = accounts.map((account) => {
        const backend = client.rpc(ConversationBackend.Api)
        const portal = createPortal({ storage, session: client.session, backend, policy: account.policy, controls: account.controls })
        let channel: ReturnType<typeof openQQChannel> | undefined
        const ready = Promise.withResolvers<boolean>()
        const replies = account.controls ? createControlReplies({ storage, policy: account.policy, permissions: account.controls,
          send: (source, text) => channel ? channel.send(source, text) : Promise.resolve({ status: "unavailable" as const }),
          publish: portal.linkControlView,
        }) : undefined
        const tasks = openTaskReplies({ client, backend, storage, policy: account.policy, sourceFor: portal.sourceFor, linkReply: portal.linkReply, ready: ready.promise,
          send: (source, text) => channel ? channel.send(source, text) : Promise.resolve({ status: "unavailable" as const }),
          onReceipt: (receipt) => {
            if (receipt.status === "uncertain" || receipt.status === "conflict") observe.onIssue?.({ kind: "notification-uncertain" })
            if (receipt.status === "sent" && receipt.linkage === "unlinked") observe.onIssue?.({ kind: "notification-unlinked" })
            if (receipt.status === "forbidden" || receipt.status === "unavailable") observe.onIssue?.({ kind: "notification-unavailable" })
            if (receipt.status === "rejected") observe.onIssue?.({ kind: "notification-rejected" })
          }, onUnavailable: () => observe.onIssue?.({ kind: "notification-unavailable" }),
        })
        channel = openQQChannel({
        policy: account.policy, connection: { url: account.url, token: account.token },
        portal,
        onResult: async (value) => {
          if (value.result.status === "accepted" || value.result.status === "followup" || value.result.status === "steered" || value.result.status === "amended")
            void tasks.admitted(value.result.target, value.result.inputID)
          if (replies && value.message && value.result.status === "control") {
            const receipt = await replies.deliver(value.message, value.result)
            try {
              if (receipt.status === "uncertain" || receipt.status === "conflict" || receipt.status === "unavailable" || receipt.status === "forbidden" || receipt.status === "rejected") observe.onIssue?.({ kind: receipt.status === "uncertain" || receipt.status === "conflict" ? "notification-uncertain" : receipt.status === "unavailable" || receipt.status === "forbidden" ? "notification-unavailable" : "notification-rejected", source: value.source })
              if (receipt.status === "sent" && receipt.linkage === "unlinked") observe.onIssue?.({ kind: "notification-unlinked", source: value.source })
            } catch { /* An observer cannot invalidate a confirmed receipt or cause another send. */ }
          }
          await observe.onResult?.(value)
        }, onIssue: observe.onIssue,
        onState: (state) => observe.onState?.(account.policy.botID, state),
        })
        void channel.ready.then((state) => ready.resolve(state.phase === "online"))
        return { close: async () => { await channel!.close(); await tasks.close() } }
      })
      return { close: async () => { await Promise.allSettled(channels.map((channel) => channel.close())) } }
    },
  }
}
