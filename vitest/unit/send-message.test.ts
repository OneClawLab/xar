/**
 * Unit tests for send_message tool
 *
 * Verifies that deliverToAgent sends a pure fire-and-forget message:
 * no reply_to, no task_context injected into the InboundMessage.
 * Requirements: 8.1, 8.4
 */

import { describe, it, expect, vi } from 'vitest'
import { createSendMessageTool, splitTarget, findPeerSource } from '../../src/agent/send-message.js'
import type { SendMessageDeps } from '../../src/agent/send-message.js'
import type { InboundMessage } from '../../src/types.js'
import type { ThreadEvent } from 'thread'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDeps(overrides: Partial<SendMessageDeps> = {}): SendMessageDeps {
  return {
    agentId: 'orchestrator',
    threadStore: {
      peek: vi.fn(async () => []),
      push: vi.fn(async () => ({ id: 1, source: 'self', type: 'record' as const, subtype: null, content: '', created_at: '' })),
    } as never,
    ipcConn: undefined,
    sendToAgent: vi.fn(() => true),
    convId: 'conv-abc',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    nextStreamSeq: () => 1,
    ...overrides,
  }
}

async function callHandler(deps: SendMessageDeps, target: string, content: string) {
  const tool = createSendMessageTool(deps)
  return (tool.handler as (args: unknown) => Promise<unknown>)({ target, content })
}

// ── splitTarget ───────────────────────────────────────────────────────────────

describe('splitTarget', () => {
  it('splits peer target', () => {
    expect(splitTarget('peer:alice')).toEqual(['peer', 'alice'])
  })

  it('splits agent target', () => {
    expect(splitTarget('agent:bot1')).toEqual(['agent', 'bot1'])
  })

  it('handles target with no colon', () => {
    expect(splitTarget('unknown')).toEqual(['unknown', ''])
  })

  it('handles agent id containing colons', () => {
    // Only splits on first colon
    expect(splitTarget('agent:ns:id')).toEqual(['agent', 'ns:id'])
  })
})

// ── findPeerSource ────────────────────────────────────────────────────────────

describe('findPeerSource', () => {
  const makeEvent = (source: string, id = 1): ThreadEvent => ({
    id, source, type: 'message', subtype: null, content: '', created_at: '',
  })

  it('returns undefined for empty events', () => {
    expect(findPeerSource([], 'alice')).toBeUndefined()
  })

  it('returns undefined when no external source matches', () => {
    const events = [
      makeEvent('internal:agent:conv:bot'),
      makeEvent('self'),
    ]
    expect(findPeerSource(events, 'alice')).toBeUndefined()
  })

  it('returns the matching external source', () => {
    const events = [
      makeEvent('external:telegram:main:dm:conv1:alice', 1),
    ]
    expect(findPeerSource(events, 'alice')).toBe('external:telegram:main:dm:conv1:alice')
  })

  it('returns the LAST matching source (most recent)', () => {
    const events = [
      makeEvent('external:telegram:main:dm:conv1:alice', 1),
      makeEvent('external:telegram:main:dm:conv2:alice', 2),
    ]
    expect(findPeerSource(events, 'alice')).toBe('external:telegram:main:dm:conv2:alice')
  })

  it('ignores non-matching external sources', () => {
    const events = [
      makeEvent('external:telegram:main:dm:conv1:bob', 1),
      makeEvent('external:telegram:main:dm:conv1:alice', 2),
    ]
    expect(findPeerSource(events, 'bob')).toBe('external:telegram:main:dm:conv1:bob')
  })
})

// ── deliverToAgent: fire-and-forget purity ────────────────────────────────────

describe('deliverToAgent — fire-and-forget purity (Requirements 8.1, 8.4)', () => {
  it('sends message with only source and content — no reply_to', async () => {
    let captured: InboundMessage | undefined
    const deps = makeDeps({
      sendToAgent: (_id, msg) => { captured = msg; return true },
    })

    await callHandler(deps, 'agent:worker', 'do the task')

    expect(captured).toBeDefined()
    expect(captured).not.toHaveProperty('reply_to')
  })

  it('sends message with only source and content — no task_context', async () => {
    let captured: InboundMessage | undefined
    const deps = makeDeps({
      sendToAgent: (_id, msg) => { captured = msg; return true },
    })

    await callHandler(deps, 'agent:worker', 'do the task')

    expect(captured).toBeDefined()
    expect(captured).not.toHaveProperty('task_context')
  })

  it('source is internal: prefixed', async () => {
    let captured: InboundMessage | undefined
    const deps = makeDeps({
      sendToAgent: (_id, msg) => { captured = msg; return true },
    })

    await callHandler(deps, 'agent:worker', 'hello')

    expect(captured?.source).toMatch(/^internal:/)
  })

  it('content is passed through unchanged', async () => {
    let captured: InboundMessage | undefined
    const deps = makeDeps({
      sendToAgent: (_id, msg) => { captured = msg; return true },
    })

    const content = 'analyze the quarterly report'
    await callHandler(deps, 'agent:analyst', content)

    expect(captured?.content).toBe(content)
  })

  it('routes to the correct agent id', async () => {
    const sendToAgent = vi.fn(() => true)
    const deps = makeDeps({ sendToAgent })

    await callHandler(deps, 'agent:analyst', 'go')

    expect(sendToAgent).toHaveBeenCalledOnce()
    expect(sendToAgent.mock.calls[0]![0]).toBe('analyst')
  })

  it('returns delivered status on success', async () => {
    const deps = makeDeps()
    const result = await callHandler(deps, 'agent:worker', 'task') as { status: string; target: string }

    expect(result.status).toBe('delivered')
    expect(result.target).toBe('agent:worker')
  })

  it('returns error when sendToAgent is undefined', async () => {
    const deps = makeDeps({ sendToAgent: undefined })
    const result = await callHandler(deps, 'agent:worker', 'task') as { status: string }

    expect(result.status).toBe('error')
  })

  it('returns error when sendToAgent returns false (agent not running)', async () => {
    const deps = makeDeps({ sendToAgent: vi.fn(() => false) })
    const result = await callHandler(deps, 'agent:worker', 'task') as { status: string }

    expect(result.status).toBe('error')
  })
})

// ── invalid target ────────────────────────────────────────────────────────────

describe('invalid target', () => {
  it('returns error for unknown target prefix', async () => {
    const deps = makeDeps()
    const result = await callHandler(deps, 'unknown:foo', 'msg') as { status: string }
    expect(result.status).toBe('error')
  })
})
