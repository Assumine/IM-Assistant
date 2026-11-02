import { createHash } from "node:crypto"
import type { ApplicationModule } from "../../../opencode/packages/plugin/src/promise/application"
import { createQQChatbot, type ChatIssue } from "./channel"
import { readSettings } from "./settings"

/** Declarative product adapter, not a separate model runtime or task controller. */
export async function configuredChatbot(home: string, location: { directory: string }, environment: NodeJS.ProcessEnv = process.env,
  observe: { onIssue?: (issue: ChatIssue) => void } = {}): Promise<ApplicationModule | undefined> {
  const config = await readSettings(home)
  if (!config.enabled) return undefined
  const accounts = config.accounts.filter((account) => account.enabled).map((account) => {
    const token = environment[account.tokenEnv] ?? ""
    delete environment[account.tokenEnv]
    return { ...account, connection: { url: account.url, token },
      replyConfiguration: createHash("sha256").update(JSON.stringify([account.policy.repliesEnabled, account.contextGeneration])).digest("hex") }
  })
  if (!accounts.length) return undefined
  return createQQChatbot({ location, accounts, onIssue: observe.onIssue })
}
