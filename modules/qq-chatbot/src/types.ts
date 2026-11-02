import type { ApplicationModule } from "../../../opencode/packages/plugin/src/promise/application"
import type { Scope } from "../../qq-protocol/src/index"
import type { PromptInput } from "../../../opencode/packages/schema/src/prompt-input"

export type Context = Parameters<ApplicationModule["open"]>[0]
export type Account = {
  botID: string
  model: { providerID: string; id: string; variant?: string }
  agentID?: string
  /** Explicitly increased to start new native histories while retaining previous generations. */
  contextGeneration?: number
  persona: { name: string; prompt: string }
}
export type Configuration = { location: { directory: string }; accounts: readonly Account[] }
/** Already authorized by this plugin's ingress policy, never a task-portal binding or command. */
export type ChatInput = { scope: Scope; actorID: string; messageID: string; text: string; displayName?: string;
  images?: readonly string[]; mentions?: readonly string[]; quoteID?: string; files?: readonly PromptInput.FileAttachment[] }
export type Receipt =
  | { status: "accepted"; sessionID: string; inputID: string; duplicate: boolean }
  | { status: "observed"; sessionID: string; inputID: string; duplicate: boolean }
  | { status: "blocked"; reason: "invalid-input" | "unknown-account" | "configuration-changed" | "session-mismatch" | "input-conflict" | "image-model-unsupported" }
  | { status: "unavailable" | "uncertain" }
