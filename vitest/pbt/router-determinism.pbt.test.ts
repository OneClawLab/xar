/**
 * Property-based tests for Router determinism
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
        fc.constant('per-conversation'),
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

  // Generate safe IDs: non-empty, no colons, no slashes, no whitespace
  const idArb = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,19}$/)

  /**
   * Build a valid source address for the given routing mode and id.
   */
  function buildSource(routing: string, id: string): string {
    // All modes use external source format
    return `external:tui:default:dm:${id}:${id}`
  }

  it('Property: Router Determinism - same inputs always produce same thread ID', () => {
    fc.assert(
      fc.property(configArb, idArb, (config, id) => {
        const source = buildSource((config as AgentConfig).routing.default, id)
        const threadId1 = determineThreadId(config as AgentConfig, source)
        const threadId2 = determineThreadId(config as AgentConfig, source)
        return threadId1 === threadId2
      }),
      { numRuns: 100 },
    )
  })

  it('Property: Different peer IDs produce different thread IDs in per-peer mode', () => {
    fc.assert(
      fc.property(idArb, idArb, (peerId1, peerId2) => {
        const config: AgentConfig = {
          agent_id: 'test',
          kind: 'user',
          pai: { provider: 'openai', model: 'gpt-4o' },
          routing: { default: 'per-peer' },
          memory: { compact_threshold_tokens: 8000, session_compact_threshold_tokens: 4000 },
          retry: { max_attempts: 3 },
        }

        const t1 = determineThreadId(config, `external:tui:default:dm:${peerId1}:${peerId1}`)
        const t2 = determineThreadId(config, `external:tui:default:dm:${peerId2}:${peerId2}`)

        return peerId1 === peerId2 ? t1 === t2 : t1 !== t2
      }),
      { numRuns: 100 },
    )
  })
})
