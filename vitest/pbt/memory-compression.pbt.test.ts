/**
 * Property-based tests for memory compression
 * Tests: estimateTokens determinism, shouldCompact monotonicity, splitMessages invariants
 */

import { describe, it } from 'vitest'
import fc from 'fast-check'
import {
  estimateTokens,
  estimateMessageTokens,
  splitMessages,
  type SessionMessage,
} from '../../src/agent/session.js'
import { shouldCompact, estimateTotalTokens } from '../../src/agent/memory.js'

const sessionMessageArb: fc.Arbitrary<SessionMessage> = fc.record({
  role: fc.constantFrom('user' as const, 'assistant' as const, 'tool' as const),
  content: fc.string(),
})

describe('Memory Compression Property Tests', () => {
  it('Property: estimateTokens is deterministic — same input always produces same output', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        return estimateTokens(text) === estimateTokens(text)
      }),
      { numRuns: 200 },
    )
  })

  it('Property: estimateTokens is non-negative for any input', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        return estimateTokens(text) >= 0
      }),
      { numRuns: 200 },
    )
  })

  it('Property: splitMessages preserves total count — toSummarize + recentRaw = input length', () => {
    fc.assert(
      fc.property(
        fc.array(sessionMessageArb, { minLength: 0, maxLength: 50 }),
        fc.integer({ min: 1, max: 100000 }),
        (msgs, budget) => {
          const { toSummarize, recentRaw } = splitMessages(msgs, budget)
          return toSummarize.length + recentRaw.length === msgs.length
        },
      ),
      { numRuns: 100 },
    )
  })

  it('Property: shouldCompact returns true when tokens exceed 80% of budget', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 8001, max: 100000 }),
        fc.integer({ min: 1, max: 5 }),
        (tokens, turnCount) => {
          // budget = 10000, 80% = 8000, tokens > 8000 → should compact
          return shouldCompact(tokens, 10000, { turnCount, lastCompactedAt: 0 }) === true
        },
      ),
      { numRuns: 100 },
    )
  })

  it('Property: estimateTotalTokens is always positive when any input is non-empty', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.array(sessionMessageArb),
        fc.string({ minLength: 1 }),
        (system, msgs, user) => {
          return estimateTotalTokens(system, msgs, user) > 0
        },
      ),
      { numRuns: 100 },
    )
  })
})
