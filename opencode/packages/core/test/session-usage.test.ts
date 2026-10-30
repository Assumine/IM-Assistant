import { expect, test } from "bun:test"
import { Usage } from "@opencode/ai/effect"
import { Money } from "@opencode/schema/money"
import { SessionUsage } from "@opencode/core/session/usage"
import { TokenUsage } from "@opencode/schema/token-usage"
import { Schema } from "effect"

// $1 per million fresh input tokens, so a million of them price at $1 from the catalog.
const costs = [
  {
    input: Money.USDPerMillionTokens.make(1),
    output: Money.USDPerMillionTokens.make(2),
    cache: { read: Money.USDPerMillionTokens.zero, write: Money.USDPerMillionTokens.zero },
  },
]

test("prices the tokens from the catalog when the endpoint reports no cost", () => {
  expect(SessionUsage.record(new Usage({ nonCachedInputTokens: 1_000_000 }), costs).cost).toBe(Money.USD.make(1))
})

test("records the cost the endpoint reports instead of the catalog price", () => {
  expect(SessionUsage.record(new Usage({ nonCachedInputTokens: 1_000_000, cost: 0.25 }), costs).cost).toBe(
    Money.USD.make(0.25),
  )
})

test("keeps a reported zero cost, as for a request a subscription covered", () => {
  expect(SessionUsage.record(new Usage({ nonCachedInputTokens: 1_000_000, cost: 0 }), costs)).toEqual({
    tokens: { input: 1_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 },
      provenance: { input: true, output: false, reasoning: false, cacheRead: false, cacheWrite: false, cost: "reported" } },
    cost: Money.USD.zero,
  })
})

test("distinguishes an absent report, explicit zero and invalid fields without inventing counts", () => {
  const absent = SessionUsage.record(undefined, [])
  const zero = SessionUsage.record(new Usage({ nonCachedInputTokens: 0, outputTokens: 0,
    cacheReadInputTokens: 0, cacheWriteInputTokens: 0, reasoningTokens: 0, cost: 0 }), [])
  expect(absent.tokens.provenance).toEqual({ input: false, output: false, reasoning: false,
    cacheRead: false, cacheWrite: false, cost: "unavailable" })
  expect(zero.tokens.provenance).toEqual({ input: true, output: true, reasoning: true,
    cacheRead: true, cacheWrite: true, cost: "reported" })
  expect(TokenUsage.total(absent.tokens)).toBe(0)
  expect(TokenUsage.total(zero.tokens)).toBe(0)
  const invalid = SessionUsage.record(new Usage({ nonCachedInputTokens: -1, outputTokens: NaN, cost: Infinity }), costs)
  expect(invalid.cost).toBe(Money.USD.zero)
  expect(invalid.tokens.provenance).toMatchObject({ input: false, output: false, cost: "catalog" })
})

test("preserves disjoint cached, reasoning and visible counts and conservative aggregate provenance", () => {
  const a = SessionUsage.record(new Usage({ nonCachedInputTokens: 10, outputTokens: 8, reasoningTokens: 3,
    cacheReadInputTokens: 20, cacheWriteInputTokens: 2, cost: 0 }), costs)
  const b = SessionUsage.record(new Usage({ nonCachedInputTokens: 5, outputTokens: 2 }), costs)
  expect(TokenUsage.total(a.tokens)).toBe(40)
  expect(a.tokens.output).toBe(5)
  const combined = SessionUsage.add(a, b)
  expect(TokenUsage.total(combined.tokens)).toBe(47)
  expect(combined.tokens.provenance).toEqual({ input: true, output: true, reasoning: false,
    cacheRead: false, cacheWrite: false, cost: "mixed" })
  const legacy = Schema.decodeUnknownSync(TokenUsage.Info)({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
  expect(legacy.provenance).toBeUndefined()
  expect(SessionUsage.add(a, { cost: Money.USD.zero, tokens: legacy }).tokens.provenance).toBeUndefined()
  expect(Schema.decodeUnknownSync(TokenUsage.Info)(Schema.encodeSync(TokenUsage.Info)(a.tokens))).toEqual(a.tokens)
})
