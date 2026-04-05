/**
 * Property-based tests for the Router module.
 * Feature: communication-refactor
 */

import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  determineThreadId,
  determineEventType,
  parseSource,
  buildSource,
} from '../../src/agent/router.js'
import type { AgentConfig } from '../../src/agent/types.js'

// ── Generators ──────────────────────────────────────────────────────────────

/** Safe identifier: lowercase alphanumeric + hyphens, no colons */
const genId = fc.stringMatching(/^[a-z][a-z0-9-]{0,19}$/)

/** AgentConfig with reactive mode */
const genReactiveConfig = (trigger: 'mention' | 'all' = 'mention'): fc.Arbitrary<AgentConfig> =>
  fc.record({
    agent_id: genId,
    kind: fc.constantFrom('system' as const, 'user' as const),
    pai: fc.record({ provider: genId, model: genId }),
    routing: fc.constant({ mode: 'reactive' as const, trigger }),
    memory: fc.record({
      compact_threshold_tokens: fc.integer({ min: 1000, max: 100000 }),
      session_compact_threshold_tokens: fc.integer({ min: 500, max: 50000 }),
    }),
    retry: fc.record({ max_attempts: fc.integer({ min: 1, max: 10 }) }),
  })

/** AgentConfig with autonomous mode */
const genAutonomousConfig: fc.Arbitrary<AgentConfig> = fc.record({
  agent_id: genId,
  kind: fc.constantFrom('system' as const, 'user' as const),
  pai: fc.record({ provider: genId, model: genId }),
  routing: fc.constant({ mode: 'autonomous' as const, trigger: 'all' as const }),
  memory: fc.record({
    compact_threshold_tokens: fc.integer({ min: 1000, max: 100000 }),
    session_compact_threshold_tokens: fc.integer({ min: 500, max: 50000 }),
  }),
  retry: fc.record({ max_attempts: fc.integer({ min: 1, max: 10 }) }),
})

/** External DM source: external:<ch_type>:<ch_instance>:dm:<conv_id>:<peer_id> */
const genExternalDmSource = fc.tuple(genId, genId, genId, genId).map(
  ([chType, chInst, convId, peerId]) => `external:${chType}:${chInst}:dm:${convId}:${peerId}`,
)

/** External group source */
const genExternalGroupSource = fc.tuple(genId, genId, genId, genId).map(
  ([chType, chInst, convId, peerId]) => `external:${chType}:${chInst}:group:${convId}:${peerId}`,
)

/** Internal source: internal:<conv_type>:<conv_id>:<sender> */
const genInternalSource = fc.tuple(genId, genId, genId).map(
  ([convType, convId, sender]) => `internal:${convType}:${convId}:${sender}`,
)

// ── Property 5: Thread 分配正确性 ────────────────────────────────────────────
// Feature: communication-refactor, Property 5: Thread 分配正确性
// Validates: Requirements 4.1, 4.2, 4.3, 4.4, 11.3

describe('Property 5: Thread 分配正确性', () => {
  it('reactive + external dm → result starts with peers/', () => {
    fc.assert(
      fc.property(
        fc.oneof(genReactiveConfig('mention'), genReactiveConfig('all')),
        genExternalDmSource,
        (config, source) => {
          const threadId = determineThreadId(config, source)
          expect(threadId.startsWith('peers/')).toBe(true)
        },
      ),
      { numRuns: 200 },
    )
  })

  it('reactive + external group → starts with conversations/ and contains /peers/', () => {
    fc.assert(
      fc.property(
        fc.oneof(genReactiveConfig('mention'), genReactiveConfig('all')),
        genExternalGroupSource,
        (config, source) => {
          const threadId = determineThreadId(config, source)
          expect(threadId.startsWith('conversations/')).toBe(true)
          expect(threadId.includes('/peers/')).toBe(true)
        },
      ),
      { numRuns: 200 },
    )
  })

  it('autonomous + external → starts with conversations/ and does NOT contain /peers/', () => {
    fc.assert(
      fc.property(
        genAutonomousConfig,
        fc.oneof(genExternalDmSource, genExternalGroupSource),
        (config, source) => {
          const threadId = determineThreadId(config, source)
          expect(threadId.startsWith('conversations/')).toBe(true)
          expect(threadId.includes('/peers/')).toBe(false)
        },
      ),
      { numRuns: 200 },
    )
  })

  it('internal → result starts with internal/', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.oneof(genReactiveConfig('mention'), genReactiveConfig('all')),
          genAutonomousConfig,
        ),
        genInternalSource,
        (config, source) => {
          const threadId = determineThreadId(config, source)
          expect(threadId.startsWith('internal/')).toBe(true)
        },
      ),
      { numRuns: 200 },
    )
  })
})

// ── Property 6: Event Type 判定正确性 ────────────────────────────────────────
// Feature: communication-refactor, Property 6: Event Type 判定正确性
// Validates: Requirements 3.3, 3.4, 3.5, 9.2

describe('Property 6: Event Type 判定正确性', () => {
  it('reactive + mention trigger + group + mentioned=false → record', () => {
    fc.assert(
      fc.property(
        genReactiveConfig('mention'),
        fc.constantFrom('group' as const, 'channel' as const),
        (config, convType) => {
          const result = determineEventType(config, { conversation_type: convType, mentioned: false })
          expect(result).toBe('record')
        },
      ),
      { numRuns: 200 },
    )
  })

  it('reactive + mention trigger + group + mentioned=true → message', () => {
    fc.assert(
      fc.property(
        genReactiveConfig('mention'),
        fc.constantFrom('group' as const, 'channel' as const),
        (config, convType) => {
          const result = determineEventType(config, { conversation_type: convType, mentioned: true })
          expect(result).toBe('message')
        },
      ),
      { numRuns: 200 },
    )
  })

  it('reactive + mention trigger + dm → message', () => {
    fc.assert(
      fc.property(
        genReactiveConfig('mention'),
        (config) => {
          const result = determineEventType(config, { conversation_type: 'dm' })
          expect(result).toBe('message')
        },
      ),
      { numRuns: 200 },
    )
  })

  it('reactive + all trigger → message (any conv type)', () => {
    fc.assert(
      fc.property(
        genReactiveConfig('all'),
        fc.oneof(
          fc.constant({ conversation_type: 'dm' as const }),
          fc.constant({ conversation_type: 'group' as const, mentioned: false }),
          fc.constant({ conversation_type: 'group' as const, mentioned: true }),
        ),
        (config, msg) => {
          const result = determineEventType(config, msg)
          expect(result).toBe('message')
        },
      ),
      { numRuns: 200 },
    )
  })

  it('autonomous → message (any conv type and mentioned value)', () => {
    fc.assert(
      fc.property(
        genAutonomousConfig,
        fc.oneof(
          fc.constant({ conversation_type: 'dm' as const }),
          fc.constant({ conversation_type: 'group' as const, mentioned: false }),
          fc.constant({ conversation_type: 'group' as const, mentioned: true }),
        ),
        (config, msg) => {
          const result = determineEventType(config, msg)
          expect(result).toBe('message')
        },
      ),
      { numRuns: 200 },
    )
  })
})

// ── Property 11: Source 地址解析 round-trip ──────────────────────────────────
// Feature: communication-refactor, Property 11: Source 地址解析 round-trip
// Validates: Requirements 4.1, 4.2, 4.3, 4.4

describe('Property 11: Source 地址解析 round-trip', () => {
  it('external source: buildSource(parseSource(s)) re-parses to same fields', () => {
    fc.assert(
      fc.property(genExternalDmSource, (source) => {
        const parsed = parseSource(source)
        const rebuilt = buildSource(parsed)
        const reparsed = parseSource(rebuilt)
        expect(reparsed.kind).toBe(parsed.kind)
        expect(reparsed.channel_id).toBe(parsed.channel_id)
        expect(reparsed.conversation_type).toBe(parsed.conversation_type)
        expect(reparsed.conversation_id).toBe(parsed.conversation_id)
        expect(reparsed.peer_id).toBe(parsed.peer_id)
      }),
      { numRuns: 200 },
    )
  })

  it('external group source: buildSource(parseSource(s)) re-parses to same fields', () => {
    fc.assert(
      fc.property(genExternalGroupSource, (source) => {
        const parsed = parseSource(source)
        const rebuilt = buildSource(parsed)
        const reparsed = parseSource(rebuilt)
        expect(reparsed.kind).toBe(parsed.kind)
        expect(reparsed.channel_id).toBe(parsed.channel_id)
        expect(reparsed.conversation_type).toBe(parsed.conversation_type)
        expect(reparsed.conversation_id).toBe(parsed.conversation_id)
        expect(reparsed.peer_id).toBe(parsed.peer_id)
      }),
      { numRuns: 200 },
    )
  })

  it('internal source: buildSource(parseSource(s)) re-parses to same fields', () => {
    fc.assert(
      fc.property(genInternalSource, (source) => {
        const parsed = parseSource(source)
        const rebuilt = buildSource(parsed)
        const reparsed = parseSource(rebuilt)
        expect(reparsed.kind).toBe(parsed.kind)
        expect(reparsed.conversation_type).toBe(parsed.conversation_type)
        expect(reparsed.conversation_id).toBe(parsed.conversation_id)
        expect(reparsed.sender_agent_id).toBe(parsed.sender_agent_id)
      }),
      { numRuns: 200 },
    )
  })

  it('"self" source round-trips correctly', () => {
    fc.assert(
      fc.property(fc.constant('self'), (source) => {
        const parsed = parseSource(source)
        const rebuilt = buildSource(parsed)
        expect(rebuilt).toBe('self')
      }),
      { numRuns: 200 },
    )
  })
})
