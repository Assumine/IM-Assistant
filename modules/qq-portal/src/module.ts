import type { ApplicationModule } from "../../../opencode/packages/plugin/src/promise/application"
import { ConversationBackend } from "../../../opencode/packages/schema/src/conversation-backend"
import { createPortal, openQQChannel, type ChannelOptions } from "./index"
import { readConfiguration } from "./configuration"
import { createControlReplies } from "./notifications"
import { openTaskReplies } from "./task-replies"
import { createConfirmationChannel } from "./confirmation-channel"
import { createImages, createImageReplies, imageFrameBytes } from "./images"

/** A complete application capability. Per-Location plugin setup never owns a bot connection. */
export async function configuredModule(home: string, environment: NodeJS.ProcessEnv = process.env, observe: {
  onState?: (botID: string, state: Parameters<NonNullable<ChannelOptions["onState"]>>[0]) => void
  onIssue?: ChannelOptions["onIssue"]
  onResult?: ChannelOptions["onResult"]
  onRecovery?: (botID: string, state: Parameters<NonNullable<ChannelOptions["onRecovery"]>>[0]) => void
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
        let channel: ReturnType<typeof openQQChannel> | undefined
        const images = account.images ? createImages({ config: account.images, read: (source, file) => channel ? channel.image(source, file) : Promise.resolve(undefined) }) : undefined
        const portal = createPortal({ storage, session: client.session, backend, policy: account.policy, controls: account.controls, images })
        const imageReplies = createImageReplies({ storage, policy: account.policy,
          send: (source, text) => channel ? channel.send(source, text) : Promise.resolve({ status: "unavailable" as const }) })
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
        const confirmations = createConfirmationChannel({ storage, portal, policy: account.policy,
          read: (source) => channel ? channel.read(source) : Promise.resolve(undefined),
          send: (source, text) => channel ? channel.send(source, text) : Promise.resolve({ status: "unavailable" as const }),
          describe: async (target) => {
            if (target.kind === "session") return (await client.session.get({ sessionID: target.sessionID })).title
            const value = await backend.query({ backendID: target.ref.backendID, query: { action: "read", threadID: target.ref.threadID } })
            if (!value || typeof value !== "object" || !("thread" in value) || !value.thread || typeof value.thread !== "object" ||
              !("id" in value.thread) || value.thread.id !== target.ref.threadID) return undefined
            return "name" in value.thread && typeof value.thread.name === "string" ? value.thread.name : undefined
          },
          onReceipt: (receipt) => {
            if (receipt.status === "uncertain" || receipt.status === "conflict") observe.onIssue?.({ kind: "notification-uncertain" })
            if (receipt.status === "sent" && receipt.linkage === "unlinked") observe.onIssue?.({ kind: "notification-unlinked" })
            if (receipt.status === "forbidden" || receipt.status === "unavailable") observe.onIssue?.({ kind: "notification-unavailable" })
            if (receipt.status === "rejected") observe.onIssue?.({ kind: "notification-rejected" })
          },
        })
        channel = openQQChannel({
        policy: account.policy, connection: { url: account.url, token: account.token, ...(account.images ? { maxFrameBytes: imageFrameBytes(account.images.maxBytes) } : {}) },
        portal: confirmations,
        ...(account.history ? { history: { config: account.history, storage } } : {}),
        onRecovery: (value) => observe.onRecovery?.(account.policy.botID, value),
        onResult: async (value) => {
          const result = value.result.status === "confirmation-control" ? value.result.result : value.result
          if (value.message && result.status === "blocked") {
            const receipt = await imageReplies(value.message, result)
            if (receipt.status !== "sent" && receipt.status !== "ignored") observe.onIssue?.({ kind: "notification-uncertain", source: value.source })
          }
          if (result.status === "accepted" || result.status === "followup" || result.status === "steered" || result.status === "amended")
            if (!await tasks.admitted(result.target, result.inputID)) throw new Error("QQ result subscription was not retained")
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
