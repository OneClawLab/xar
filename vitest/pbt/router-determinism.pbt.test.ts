/**
 * Property-based tests for Router determinism
 * Validates: Requirements 6.1
 */

import { describe, it } from 'vitest'
import fc from 'fast-check'
import { determineThreadId } from '../../src/agent/router.js'
import type { AgentConfig } from '../../src/agent/types.js'

describe('Router Determinism Property Tests', () => {
  const configArb = fc.record({
    agent_id: fc.string({ minLength: 1 }),
    kind: fc.oneof(fc.constant('system'), fc.constant('user')),
    pai: fc.record({
      provider: fc.string({ minLength: 1 }),
      model: fc.string({ minLength: 1 }),
    }),
    routing: fc.record({
      default: fc.oneof(
        fc.constant('per-peer'),
        fc.constant('per-session'),
        fc.constant('per-agent'),
      ),
    }),
    memory: fc.record({
      compact_threshold_tokens: fc.integer({ min: 1 }),
      session_compact_threshold_tokens: fc.integer({ min: 1 }),
    }),
    retry: fc.record({
      max_attempts: fc.integer({ min: 1 }),
    }),
  })

  // Generate non-empty IDs that don't contain colons
  const idArb = fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0 && !s.includes(':'))

  it('Property 2: Router Determinism - For any agent configuration and source, the Router SHALL always produce the same target thread ID when given identical inputs', () => {
    fc.assert(
      fc.property(configArb, idArb, (config, id) => {
        // Generate source based on routing mode to ensure valid combinations
        const routing = (config as AgentConfig).routing.default
        let source: string

        if (routing === 'per-session') {
          source = `session:${id}`
        } else if (routing === 'per-peer') {
          source = `peer:${id}`
        } else {
          source = `agent:${id}`
        }

        const threadId1 = determineThreadId(config as AgentConfig, source)
        const threadId2 = determineThreadId(config as AgentConfig, source)
        return threadId1 === threadId2
      }),
      { numRuns: 100 },
    )
  })

  it('Property 2: Router produces different thread IDs for different peer IDs in per-peer mode', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        idArb,
        idArb,
        (agentId, peerId1, peerId2) => {
          const config: AgentConfig = {
            agent_id: agentId,
            kind: 'user',
            pai: { provider: 'openai', model: 'gpt-4o' },
            routing: { default: 'per-peer' },
            memory: { compact_threshold_tokens: 8000, session_compact_threshold_tokens: 4000 },
            retry: { max_attempts: 3 },
          }

          const threadId1 = determineThreadId(config, `peer:${peerId1}`)
          const threadId2 = determineThreadId(config, `peer:${peerId2}`)

          // If peer IDs are different, thread IDs should be different
          return peerId1 === peerId2 ? threadId1 === threadId2 : threadId1 !== threadId2
        },
      ),
      { numRuns: 100 },
    )
  })
})
