export * as SessionUsage from "./usage.js"

import type { Usage } from "@opencode/ai/effect"
import { Money } from "@opencode/schema/money"
import type { TokenUsage } from "@opencode/schema/token-usage"
import type { Model } from "@opencode/schema/model"

const finite = (value: number) => (Number.isFinite(value) ? value : 0)
const safe = (value: number | undefined) => Math.max(0, finite(value ?? 0))
const reported = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value >= 0

export const tokens = (usage: Usage | undefined) => ({
  input: safe(usage?.nonCachedInputTokens),
  output: safe(usage?.visibleOutputTokens),
  reasoning: safe(usage?.reasoningTokens),
  cache: {
    read: safe(usage?.cacheReadInputTokens),
    write: safe(usage?.cacheWriteInputTokens),
  },
  provenance: {
    input: reported(usage?.nonCachedInputTokens),
    output: reported(usage?.outputTokens),
    reasoning: reported(usage?.reasoningTokens),
    cacheRead: reported(usage?.cacheReadInputTokens),
    cacheWrite: reported(usage?.cacheWriteInputTokens),
  },
} satisfies TokenUsage.Info)

// Catalog pricing is the fallback for endpoints that don't report what they charged (`Usage.cost`).
// TODO(#35765): Normalize Copilot's reported billed amount into `Usage.cost`.
function pricing(costs: Model.Info["cost"], usage: TokenUsage.Info) {
  const context = usage.input + usage.cache.read + usage.cache.write
  const tier = costs
    .filter((cost) => cost.tier?.type === "context" && context > cost.tier.size)
    .toSorted((a, b) => (b.tier?.size ?? 0) - (a.tier?.size ?? 0))[0]
  return tier ?? costs.find((cost) => cost.tier === undefined)
}

export function calculateCost(costs: Model.Info["cost"], usage: TokenUsage.Info) {
  const cost = pricing(costs, usage)
  if (!cost) return Money.USD.zero
  return Money.USD.make(
    (usage.input * finite(cost.input) +
      (usage.output + usage.reasoning) * finite(cost.output) +
      usage.cache.read * finite(cost.cache.read) +
      usage.cache.write * finite(cost.cache.write)) /
      1_000_000,
  )
}

export type Recorded = {
  readonly tokens: TokenUsage.Info
  readonly cost: Money.USD
}

export const record = (usage: Usage | undefined, costs: Model.Info["cost"]): Recorded => {
  const normalized = tokens(usage)
  const billed = usage?.cost
  return {
    tokens: { ...normalized, provenance: { ...normalized.provenance,
      cost: reported(billed) ? "reported" : pricing(costs, normalized) ? "catalog" : "unavailable" } },
    // What an endpoint says it charged beats the catalog, which can't see its peak pricing, subscriptions or routing.
    // A reported zero is authoritative.
    cost: reported(billed) ? Money.USD.make(billed) : calculateCost(costs, normalized),
  }
}

export const add = (a: Recorded, b: Recorded): Recorded => ({
  cost: Money.USD.make(a.cost + b.cost),
  tokens: {
    input: a.tokens.input + b.tokens.input,
    output: a.tokens.output + b.tokens.output,
    reasoning: a.tokens.reasoning + b.tokens.reasoning,
    cache: {
      read: a.tokens.cache.read + b.tokens.cache.read,
      write: a.tokens.cache.write + b.tokens.cache.write,
    },
    provenance: a.tokens.provenance && b.tokens.provenance ? {
      input: a.tokens.provenance.input && b.tokens.provenance.input,
      output: a.tokens.provenance.output && b.tokens.provenance.output,
      reasoning: a.tokens.provenance.reasoning && b.tokens.provenance.reasoning,
      cacheRead: a.tokens.provenance.cacheRead && b.tokens.provenance.cacheRead,
      cacheWrite: a.tokens.provenance.cacheWrite && b.tokens.provenance.cacheWrite,
      cost: a.tokens.provenance.cost === undefined || b.tokens.provenance.cost === undefined ? undefined
        : a.tokens.provenance.cost === b.tokens.provenance.cost ? a.tokens.provenance.cost : "mixed",
    } : undefined,
  },
})
