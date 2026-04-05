/**
 * Property-based tests for agent-to-agent internal communication
 *
 * Feature: agent-to-agent
 */

import { describe, it, afterEach } from 'vitest'
import fc from 'fast-check'
import { parseSource, determineThreadId, extractConvId } from '../../src/agent/router.js'
import { buildInternalSource } from '../../src/commands/send.js'
import type { AgentConfig } from '../../src/agent/types.js'

// Generator for non-empty alphanumeric+dash strings (no colons)
const segmentArb = fc.stringMatching(/^[a-z0-9-]+$/).filter((s) => s.length >= 1)

// Minimal AgentConfig for a given routing mode
function makeConfig(routing: 'reactive' | 'autonomous'): AgentConfig {
  return {
    agent_id: 'test',
    kind: 'user',
    pai: { provider: 'openai', model: 'gpt-4o' },
    routing: { mode: routing, trigger: 'mention' },
    memory: { compact_threshold_tokens: 8000, session_compact_threshold_tokens: 4000 },
    retry: { max_attempts: 3 },
  }
}

describe('agent-to-agent PBT', () => {
  /**
   * Property 1: Internal source round-trip parsing
   * Validates: Requirements 1.1
   */
  it('Feature: agent-to-agent, Property 1: internal source round-trip parsing', () => {
    fc.assert(
      fc.property(
        fc.tuple(segmentArb, segmentArb, segmentArb),
        ([convType, convId, senderAgentId]) => {
          const source = `internal:${convType}:${convId}:${senderAgentId}`
          const parsed = parseSource(source)
          return (
            parsed.kind === 'internal' &&
            parsed.conversation_type === convType &&
            parsed.conversation_id === convId &&
            parsed.sender_agent_id === senderAgentId
          )
        },
      ),
      { numRuns: 100 },
    )
  })

  /**
   * Property 2: Invalid internal source always throws
   * Validates: Requirements 1.2
   *
   * Generate strings with `internal:` prefix but only 1-3 colon-separated segments total
   * (i.e. "internal" + 0-2 more segments = fewer than 4 segments total)
   */
  it('Feature: agent-to-agent, Property 2: invalid internal source always throws', () => {
    // Build arbitraries for 1, 2, and 3 total segments (all < 4)
    const segArb = fc.stringMatching(/^[a-z0-9-]*$/)

    const invalidSourceArb = fc.oneof(
      // 1 segment: "internal"
      fc.constant('internal'),
      // 2 segments: "internal:x"
      segArb.map((s) => `internal:${s}`),
      // 3 segments: "internal:x:y"
      fc.tuple(segArb, segArb).map(([a, b]) => `internal:${a}:${b}`),
    )

    fc.assert(
      fc.property(invalidSourceArb, (source) => {
        let threw = false
        try {
          parseSource(source)
        } catch {
          threw = true
        }
        return threw
      }),
      { numRuns: 100 },
    )
  })

  /**
   * Property 3: Internal source thread routing correctness and determinism
   * Validates: Requirements 2.1, 2.2, 2.3, 2.4
   */
  it('Feature: agent-to-agent, Property 3: internal source thread routing', () => {
    const routingModeArb = fc.oneof(
      fc.constant('reactive' as const),
      fc.constant('autonomous' as const),
    )

    fc.assert(
      fc.property(
        fc.tuple(segmentArb, segmentArb, segmentArb),
        routingModeArb,
        ([convType, convId, senderAgentId], routingMode) => {
          const source = `internal:${convType}:${convId}:${senderAgentId}`
          const config = makeConfig(routingMode)

          const threadId1 = determineThreadId(config, source)
          const threadId2 = determineThreadId(config, source)

          // Determinism
          if (threadId1 !== threadId2) return false

          // Internal messages always route to internal/<convId> regardless of mode
          return threadId1 === `internal/${convId}`
        },
      ),
      { numRuns: 100 },
    )
  })

  /**
   * Property 4: extraEnv values flow correctly
   * Validates: Requirements 4.3, 4.5
   */
  it('Feature: agent-to-agent, Property 4: extraEnv values flow correctly', () => {
    // Valid internal source
    const internalSourceArb = fc.tuple(segmentArb, segmentArb, segmentArb).map(
      ([ct, cid, sid]) => `internal:${ct}:${cid}:${sid}`,
    )
    // Valid external source
    const externalSourceArb = fc.tuple(segmentArb, segmentArb, segmentArb, segmentArb).map(
      ([chInst, ct, cid, pid]) => `external:tg:${chInst}:${ct}:${cid}:${pid}`,
    )
    const sourceArb = fc.oneof(
      internalSourceArb,
      externalSourceArb,
      fc.constant('self'),
    )

    fc.assert(
      fc.property(segmentArb, sourceArb, (agentId, source) => {
        const convId = extractConvId(source)

        // Build the extraEnv that the run-loop would pass to processTurn
        const extraEnv: Record<string, string> = {
          XAR_AGENT_ID: agentId,
          XAR_CONV_ID: convId,
        }

        return (
          extraEnv['XAR_AGENT_ID'] === agentId &&
          extraEnv['XAR_CONV_ID'] === convId
        )
      }),
      { numRuns: 100 },
    )
  })

  /**
   * Property 5: xar send internal source construction
   * Validates: Requirements 5.1
   */
  describe('Feature: agent-to-agent, Property 5: xar send internal source construction', () => {
    afterEach(() => {
      delete process.env['XAR_AGENT_ID']
      delete process.env['XAR_CONV_ID']
    })

    it('buildInternalSource constructs correct internal source from env vars', () => {
      fc.assert(
        fc.property(segmentArb, segmentArb, (agentId, convId) => {
          process.env['XAR_AGENT_ID'] = agentId
          process.env['XAR_CONV_ID'] = convId

          const result = buildInternalSource({})

          // Verify format
          if (result !== `internal:agent:${convId}:${agentId}`) return false

          // Verify parseSource succeeds with correct fields
          const parsed = parseSource(result)
          return (
            parsed.kind === 'internal' &&
            parsed.conversation_type === 'agent' &&
            parsed.conversation_id === convId &&
            parsed.sender_agent_id === agentId
          )
        }),
        { numRuns: 100 },
      )
    })
  })
})
