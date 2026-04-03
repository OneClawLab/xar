/**
 * Property-based tests for send_message tool
 */

import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { splitTarget, findPeerSource, createSendMessageTool } from '../../src/agent/send-message.js'
import type { ThreadEvent } from 'thread'
import type { SendMessageDeps } from '../../src/agent/send-message.js'
import type { IpcConnection } from '../../src/ipc/types.js'
import type { IpcMessage } from '../../src/types.js'

// ── Generators ───────────────────────────────────────────────────────────────

/** Safe ID: lowercase alphanumeric + hyphens, 1-20 chars */
const safeIdArb = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,19}$/)

/** Channel type (e.g. telegram, slack, tui) */
const channelTypeArb = fc.constantFrom('telegram', 'slack', 'tui', 'discord')

/** Channel instance */
const channelInstanceArb = fc.constantFrom('main', 'default', 'work', 'test')

/** Conversation type */
const convTypeArb = fc.constantFrom('dm', 'group', 'channel')

/**
 * Build a valid external source address:
 * external:<ch_type>:<ch_instance>:<conv_type>:<conv_id>:<peer_id>
 */
function externalSourceArb(peerId?: fc.Arbitrary<string>) {
  return fc.tuple(
    channelTypeArb,
    channelInstanceArb,
    convTypeArb,
    safeIdArb,
    peerId ?? safeIdArb,
  ).map(([chType, chInst, convType, convId, pid]) =>
    `external:${chType}:${chInst}:${convType}:${convId}:${pid}`,
  )
}

/**
 * Build a valid internal source address:
 * internal:<conv_type>:<conv_id>:<sender_agent_id>
 */
const internalSourceArb = fc.tuple(convTypeArb, safeIdArb, safeIdArb)
  .map(([convType, convId, agentId]) => `internal:${convType}:${convId}:${agentId}`)

/** Build a ThreadEvent with a given source */
function threadEventArb(sourceArb: fc.Arbitrary<string>): fc.Arbitrary<ThreadEvent> {
  return fc.tuple(
    fc.nat({ max: 10000 }),
    sourceArb,
    fc.constantFrom('message' as const, 'record' as const),
    fc.string({ minLength: 0, maxLength: 50 }),
  ).map(([id, source, type, content]) => ({
    id,
    source,
    type,
    subtype: null,
    content,
    created_at: new Date().toISOString(),
  }))
}

// ── Property 1 ───────────────────────────────────────────────────────────────

describe('send_message Property Tests', () => {

  // Feature: send-message-tool, Property 1: findPeerSource 返回最近的 external source
  // Validates: Requirements 1.2
  describe('Property 1: findPeerSource returns most recent external source', () => {
    it('returns the last external source matching the peer_id', () => {
      fc.assert(
        fc.property(
          safeIdArb,
          fc.array(
            fc.oneof(
              // External events with random peer IDs
              externalSourceArb(),
              // Internal events (noise)
              internalSourceArb,
              // Self events (noise)
              fc.constant('self'),
            ).chain(src => threadEventArb(fc.constant(src))),
            { minLength: 0, maxLength: 30 },
          ),
          // How many extra target-peer events to inject (at least 1)
          fc.integer({ min: 1, max: 5 }),
          (targetPeerId, mixedEvents, extraCount) => {
            // Build events that contain the target peer at known positions
            const targetSources: string[] = []
            const allEvents: ThreadEvent[] = [...mixedEvents]

            for (let i = 0; i < extraCount; i++) {
              // Pick random channel/conv params for each target event
              const chType = 'telegram'
              const chInst = 'main'
              const convType = 'dm'
              const convId = `conv-${i}`
              const src = `external:${chType}:${chInst}:${convType}:${convId}:${targetPeerId}`
              targetSources.push(src)
              allEvents.push({
                id: 10000 + i,
                source: src,
                type: 'message',
                subtype: null,
                content: `msg-${i}`,
                created_at: new Date().toISOString(),
              })
            }

            // Shuffle to randomize positions, but findPeerSource scans from end
            // So we need to know which target source is LAST in the array
            // Don't shuffle — instead, interleave: put target events at random positions
            // Actually, let's just append and verify the last one wins
            const result = findPeerSource(allEvents, targetPeerId)
            const lastTargetSource = targetSources[targetSources.length - 1]!

            // The result should be the last external source for this peer
            // Since we appended target events at the end, the last one should win
            expect(result).toBe(lastTargetSource)
          },
        ),
        { numRuns: 100 },
      )
    })

    it('returns undefined when peer_id is not in any external source', () => {
      fc.assert(
        fc.property(
          safeIdArb,
          fc.array(
            fc.oneof(
              internalSourceArb,
              fc.constant('self'),
            ).chain(src => threadEventArb(fc.constant(src))),
            { minLength: 0, maxLength: 20 },
          ),
          (targetPeerId, events) => {
            // No external sources at all → should return undefined
            const result = findPeerSource(events, targetPeerId)
            expect(result).toBeUndefined()
          },
        ),
        { numRuns: 100 },
      )
    })
  })
})