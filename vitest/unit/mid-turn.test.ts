/**
 * Unit tests for MidTurnInjector
 * Requirements: 7.1, 7.2, 7.3
 */

import { describe, it, expect, vi } from 'vitest'
import { MidTurnInjector } from '../../src/agent/mid-turn.js'
import type { ThreadStore } from 'thread'

// ── Helpers ───────────────────────────────────────────────────────────────────

type FakeEvent = {
  id: number
  source: string
  type: 'message' | 'record'
  subtype: string | undefined
  created_at: string
  content: string
}

function makeEvent(overrides: Partial<FakeEvent> & { id: number }): FakeEvent {
  return {
    source: 'external:slack:ch1:dm:conv1:user1',
    type: 'message',
    subtype: undefined,
    created_at: new Date().toISOString(),
    content: 'hello',
    ...overrides,
  }
}

function makeMockStore(events: FakeEvent[]): {
  store: ThreadStore
  pushCalls: Array<{ source: string; type: string; subtype?: string; content: string }>
} {
  const pushCalls: Array<{ source: string; type: string; subtype?: string; content: string }> = []
  const store: ThreadStore = {
    peek: vi.fn(async () => events as never),
    push: vi.fn(async (event) => {
      pushCalls.push(event as never)
      return { id: 9999, source: event.source, type: event.type, subtype: event.subtype, created_at: new Date().toISOString(), content: event.content } as never
    }),
    pushBatch: vi.fn(async () => []),
  }
  return { store, pushCalls }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MidTurnInjector.checkAndInject', () => {
  // Requirement 7.1: no new messages → returns null
  it('returns null when there are no events', async () => {
    const { store } = makeMockStore([])
    const injector = new MidTurnInjector(store)
    const result = await injector.checkAndInject(0)
    expect(result).toBeNull()
  })

  // Requirement 7.1: non-Human messages only → returns null
  it('returns null when all events are from internal source', async () => {
    const events = [
      makeEvent({ id: 1, source: 'internal:task:task1:agent1' }),
      makeEvent({ id: 2, source: 'internal:agent:conv:bot' }),
    ]
    const { store } = makeMockStore(events)
    const injector = new MidTurnInjector(store)
    const result = await injector.checkAndInject(0)
    expect(result).toBeNull()
  })

  // Requirement 7.3: type=record events are filtered out even with external source
  it('returns null when events are type=record with external source', async () => {
    const events = [
      makeEvent({ id: 1, type: 'record', subtype: 'mid_turn_injection', source: 'external:slack:ch1:dm:conv1:user1' }),
    ]
    const { store } = makeMockStore(events)
    const injector = new MidTurnInjector(store)
    const result = await injector.checkAndInject(0)
    expect(result).toBeNull()
  })

  // Requirement 7.2: single new Human message → returns message pair with correct content
  it('returns a message pair for a single Human message', async () => {
    const events = [makeEvent({ id: 1, content: 'what is the status?' })]
    const { store } = makeMockStore(events)
    const injector = new MidTurnInjector(store)
    const result = await injector.checkAndInject(0)

    expect(result).not.toBeNull()
    expect(result!.messages).toHaveLength(2)

    const [assistantMsg, toolMsg] = result!.messages
    expect(assistantMsg!.role).toBe('assistant')
    const toolCalls = (assistantMsg as never as { tool_calls: Array<{ function: { name: string } }> }).tool_calls
    expect(toolCalls[0]!.function.name).toBe('receive_user_update')

    expect(toolMsg!.role).toBe('tool')
    expect((toolMsg as never as { name: string }).name).toBe('receive_user_update')
    expect(toolMsg!.content).toBe('what is the status?')
  })

  // Requirement 7.2: multiple new Human messages → content contains all messages joined
  it('joins multiple Human messages into a single content string', async () => {
    const events = [
      makeEvent({ id: 1, content: 'first message' }),
      makeEvent({ id: 2, content: 'second message' }),
      makeEvent({ id: 3, content: 'third message' }),
    ]
    const { store } = makeMockStore(events)
    const injector = new MidTurnInjector(store)
    const result = await injector.checkAndInject(0)

    expect(result).not.toBeNull()
    expect(result!.messages[1]!.content).toContain('first message')
    expect(result!.messages[1]!.content).toContain('second message')
    expect(result!.messages[1]!.content).toContain('third message')
  })

  // Requirement 7.1: mixed events — only Human messages included in content
  it('filters out non-Human events and only includes external messages in content', async () => {
    const events = [
      makeEvent({ id: 1, content: 'human says hi', source: 'external:slack:ch1:dm:conv1:user1' }),
      makeEvent({ id: 2, content: 'internal noise', source: 'internal:task:task1:agent1' }),
      makeEvent({ id: 3, content: 'human says bye', source: 'external:slack:ch1:dm:conv1:user2' }),
    ]
    const { store } = makeMockStore(events)
    const injector = new MidTurnInjector(store)
    const result = await injector.checkAndInject(0)

    expect(result).not.toBeNull()
    const content = result!.messages[1]!.content
    expect(content).toContain('human says hi')
    expect(content).toContain('human says bye')
    expect(content).not.toContain('internal noise')
  })

  // Requirement 7.3: thread push is called with type=record, subtype=mid_turn_injection
  it('writes a record with subtype=mid_turn_injection to the thread', async () => {
    const events = [makeEvent({ id: 1, content: 'ping' })]
    const { store, pushCalls } = makeMockStore(events)
    const injector = new MidTurnInjector(store)
    await injector.checkAndInject(0)

    expect(pushCalls).toHaveLength(1)
    expect(pushCalls[0]!.type).toBe('record')
    expect(pushCalls[0]!.subtype).toBe('mid_turn_injection')
  })

  // Requirement 7.2: newLastCheckedId is updated to the max event id
  it('sets newLastCheckedId to the max event id among all events', async () => {
    // Events in ascending id order — implementation uses last element and last human element
    const events = [
      makeEvent({ id: 5, content: 'msg', source: 'external:slack:ch1:dm:conv1:user1' }),
      makeEvent({ id: 7, content: 'msg2', source: 'external:slack:ch1:dm:conv1:user2' }),
      makeEvent({ id: 10, content: 'internal', source: 'internal:task:t1:a1' }),
    ]
    const { store } = makeMockStore(events)
    const injector = new MidTurnInjector(store)
    const result = await injector.checkAndInject(0)

    expect(result).not.toBeNull()
    // lastEvent (id=10) is the last in the array, so newLastCheckedId = max(10, 7) = 10
    expect(result!.newLastCheckedId).toBe(10)
  })

  // peek is called with the correct lastEventId
  it('passes lastCheckedEventId to peek', async () => {
    const { store } = makeMockStore([])
    const injector = new MidTurnInjector(store)
    await injector.checkAndInject(42)

    expect(store.peek).toHaveBeenCalledWith({ lastEventId: 42, limit: 100 })
  })

  // peek failure → returns null gracefully
  it('returns null when peek throws', async () => {
    const store: ThreadStore = {
      peek: vi.fn(async () => { throw new Error('network error') }),
      push: vi.fn(async () => ({ id: 1 }) as never),
      pushBatch: vi.fn(async () => []),
    }
    const injector = new MidTurnInjector(store)
    const result = await injector.checkAndInject(0)
    expect(result).toBeNull()
  })
})
