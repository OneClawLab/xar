/**
 * Property-based tests for MidTurnInjector
 * Feature: communication-refactor, Property 10: Mid-Turn Injection 构造正确性
 * Validates: Requirements 7.2
 */

import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { MidTurnInjector } from '../../src/agent/mid-turn.js'
import type { ThreadStore } from 'thread'

// ── Generators ────────────────────────────────────────────────────────────────

/** A ThreadEvent-shaped object with an external Human source */
const genHumanEvent = (id: number) =>
  fc.record({
    content: fc.string({ minLength: 1, maxLength: 80 }),
  }).map(({ content }) => ({
    id,
    source: `external:slack:ch1:dm:conv1:user${id}`,
    type: 'message' as const,
    subtype: undefined,
    created_at: new Date().toISOString(),
    content,
  }))

/** A non-Human event (internal source or type=record) */
const genNonHumanEvent = (id: number) =>
  fc.oneof(
    // internal source
    fc.record({ content: fc.string({ minLength: 1, maxLength: 40 }) }).map(({ content }) => ({
      id,
      source: `internal:task:task1:agent1`,
      type: 'message' as const,
      subtype: undefined,
      created_at: new Date().toISOString(),
      content,
    })),
    // type=record with external source
    fc.record({ content: fc.string({ minLength: 1, maxLength: 40 }) }).map(({ content }) => ({
      id,
      source: `external:slack:ch1:dm:conv1:user${id}`,
      type: 'record' as const,
      subtype: 'mid_turn_injection',
      created_at: new Date().toISOString(),
      content,
    })),
  )

/**
 * Build a mock ThreadStore that returns the given events from peek().
 * Also tracks push() calls.
 */
function makeMockThreadStore(events: ReturnType<typeof genHumanEvent> extends fc.Arbitrary<infer T> ? T[] : never): {
  store: ThreadStore
  pushCalls: Array<{ source: string; type: string; subtype?: string; content: string }>
} {
  const pushCalls: Array<{ source: string; type: string; subtype?: string; content: string }> = []
  const store: ThreadStore = {
    peek: async () => events as any,
    push: async (event) => {
      pushCalls.push(event as any)
      return { id: 9999, source: event.source, type: event.type, subtype: event.subtype, created_at: new Date().toISOString(), content: event.content } as any
    },
    pushBatch: async () => [],
  }
  return { store, pushCalls }
}

// ── Property 10 ───────────────────────────────────────────────────────────────

// Feature: communication-refactor, Property 10: Mid-Turn Injection 构造正确性
// Validates: Requirements 7.2
describe('Property 10: Mid-Turn Injection 构造正确性', () => {
  it('returns null when there are no new Human messages after lastCheckedEventId', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.nat({ max: 100 }),
        // Generate 0-5 non-human events
        fc.integer({ min: 0, max: 5 }).chain(n =>
          fc.tuple(...Array.from({ length: n }, (_, i) => genNonHumanEvent(i + 1))).map(evts => evts as any[]),
        ),
        async (lastCheckedEventId, nonHumanEvents) => {
          const { store } = makeMockThreadStore(nonHumanEvents as any)
          const injector = new MidTurnInjector(store)
          const result = await injector.checkAndInject(lastCheckedEventId)
          expect(result).toBeNull()
        },
      ),
      { numRuns: 100 },
    )
  })

  it('returns a message pair when there are new Human messages, with correct structure', async () => {
    await fc.assert(
      fc.asyncProperty(
        // lastCheckedEventId in [0, 50], human event ids start at lastCheckedEventId+1
        fc.nat({ max: 50 }).chain(lastCheckedEventId =>
          fc.integer({ min: 1, max: 5 }).chain(n =>
            fc.tuple(...Array.from({ length: n }, (_, i) => genHumanEvent(lastCheckedEventId + i + 1))).map(
              evts => ({ lastCheckedEventId, humanEvents: evts as any[] }),
            ),
          ),
        ),
        async ({ lastCheckedEventId, humanEvents }) => {
          const { store } = makeMockThreadStore(humanEvents as any)
          const injector = new MidTurnInjector(store)
          const result = await injector.checkAndInject(lastCheckedEventId)

          // Must return a non-null result
          expect(result).not.toBeNull()

          // Must return exactly 2 messages
          expect(result!.messages).toHaveLength(2)

          const [assistantMsg, toolMsg] = result!.messages

          // First message: assistant with tool_calls containing receive_user_update
          expect(assistantMsg!.role).toBe('assistant')
          const toolCalls = (assistantMsg as any).tool_calls
          expect(Array.isArray(toolCalls)).toBe(true)
          expect(toolCalls).toHaveLength(1)
          expect(toolCalls[0].function.name).toBe('receive_user_update')

          // Second message: tool result with role=tool and name=receive_user_update
          expect(toolMsg!.role).toBe('tool')
          expect((toolMsg as any).name).toBe('receive_user_update')

          // Tool result content must contain all human message contents
          for (const evt of humanEvents) {
            expect(toolMsg!.content).toContain(evt.content)
          }

          // newLastCheckedId must be >= lastCheckedEventId
          expect(result!.newLastCheckedId).toBeGreaterThanOrEqual(lastCheckedEventId)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('newLastCheckedId is updated to the max event id seen', async () => {
    await fc.assert(
      fc.asyncProperty(
        // lastCheckedEventId in [0, 50], event ids start at lastCheckedEventId+1
        fc.nat({ max: 50 }).chain(lastCheckedEventId =>
          fc.integer({ min: 1, max: 6 }).chain(total =>
            fc.array(fc.boolean(), { minLength: total, maxLength: total }).chain(isHumanFlags => {
              const eventArbs = isHumanFlags.map((isHuman, i) =>
                isHuman
                  ? genHumanEvent(lastCheckedEventId + i + 1)
                  : genNonHumanEvent(lastCheckedEventId + i + 1),
              )
              return fc.tuple(...eventArbs).map(evts => ({
                lastCheckedEventId,
                events: evts as any[],
                hasHuman: isHumanFlags.some(Boolean),
                maxId: lastCheckedEventId + total,
              }))
            }),
          ),
        ),
        async ({ lastCheckedEventId, events, hasHuman, maxId }) => {
          const { store } = makeMockThreadStore(events as any)
          const injector = new MidTurnInjector(store)
          const result = await injector.checkAndInject(lastCheckedEventId)

          if (!hasHuman) {
            expect(result).toBeNull()
          } else {
            expect(result).not.toBeNull()
            // newLastCheckedId should be the max id among all events
            expect(result!.newLastCheckedId).toBe(maxId)
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})
