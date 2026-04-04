/**
 * Unit tests for agent-to-agent interaction
 *
 * Covers the run-loop behaviour when processing internal (agent-originated)
 * messages, and the full source-construction → routing → extraEnv chain that
 * enables an agent to reply back to its sender.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { InboundMessage } from '../../src/types.js'

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../src/agent/config.js', () => ({
  loadAgentConfig: vi.fn(async () => ({
    agent_id: 'receiver',
    kind: 'user',
    pai: { provider: 'openai', model: 'gpt-4o' },
    routing: { default: 'per-peer' },
    memory: { compact_threshold_tokens: 8000, session_compact_threshold_tokens: 4000 },
    retry: { max_attempts: 3 },
  })),
}))

vi.mock('../../src/agent/router.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/agent/router.js')>()
  return {
    ...real,
    routeMessage: vi.fn(async () => ({
      push: vi.fn(async () => {}),
      pushBatch: vi.fn(async () => {}),
      peek: vi.fn(async () => []),
    })),
  }
})

vi.mock('../../src/agent/context.js', () => ({
  buildContext: vi.fn(async () => ({ system: '', history: [], userMessage: 'hello' })),
}))

vi.mock('../../src/agent/turn.js', () => ({
  processTurn: vi.fn(async () => ({ newMessages: [] })),
}))

vi.mock('../../src/config.js', () => ({
  getDaemonConfig: vi.fn(() => ({ theClawHome: '/tmp/test-home' })),
}))

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { RunLoopImpl } from '../../src/agent/run-loop.js'
import { AsyncQueueImpl } from '../../src/agent/queue.js'
import { parseSource, extractConvId } from '../../src/agent/router.js'
import { buildInternalSource } from '../../src/commands/send.js'

function makePai() {
  return {
    getProviderInfo: vi.fn(async () => ({ contextWindow: 128000, maxTokens: 4096 })),
  } as any
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('agent-to-agent interaction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env['XAR_AGENT_ID']
    delete process.env['XAR_CONV_ID']
  })

  // ── Source construction ───────────────────────────────────────────────────

  describe('internal source construction', () => {
    it('buildInternalSource uses XAR_AGENT_ID and XAR_CONV_ID from env', () => {
      process.env['XAR_AGENT_ID'] = 'sender-agent'
      process.env['XAR_CONV_ID'] = 'conv-123'
      const source = buildInternalSource({})
      expect(source).toBe('internal:agent:conv-123:sender-agent')
    })

    it('explicit --source overrides env vars', () => {
      process.env['XAR_AGENT_ID'] = 'sender-agent'
      process.env['XAR_CONV_ID'] = 'conv-123'
      const source = buildInternalSource({ source: 'internal:agent:other-conv:other-agent' })
      expect(source).toBe('internal:agent:other-conv:other-agent')
    })

    it('constructed source parses back to correct fields', () => {
      process.env['XAR_AGENT_ID'] = 'evolver'
      process.env['XAR_CONV_ID'] = 'conv-abc'
      const source = buildInternalSource({})
      const parsed = parseSource(source)
      expect(parsed.kind).toBe('internal')
      expect(parsed.sender_agent_id).toBe('evolver')
      expect(parsed.conversation_id).toBe('conv-abc')
      expect(parsed.conversation_type).toBe('agent')
    })
  })

  // ── Run-loop: internal source routing ────────────────────────────────────

  describe('run-loop processes internal source messages', () => {
    it('routes internal message to peers/<sender_agent_id> thread (per-peer routing)', async () => {
      const { routeMessage } = await import('../../src/agent/router.js')
      const { processTurn } = await import('../../src/agent/turn.js')

      const queue = new AsyncQueueImpl<InboundMessage>()
      const loop = new RunLoopImpl('receiver', queue, new Map(), makePai())

      // sender-agent sends to receiver via internal source
      const source = 'internal:agent:conv-xyz:sender-agent'
      queue.push({ source, content: 'hello from sender' })
      queue.close()

      await loop.start()

      // routeMessage should have been called with the internal source
      expect(vi.mocked(routeMessage)).toHaveBeenCalledOnce()
      const [calledAgentId, , calledMsg] = vi.mocked(routeMessage).mock.calls[0]!
      expect(calledAgentId).toBe('receiver')
      expect(calledMsg.source).toBe(source)

      // processTurn should have been called
      expect(vi.mocked(processTurn)).toHaveBeenCalledOnce()
    })

    it('sets XAR_AGENT_ID=receiver and XAR_CONV_ID=conv-xyz in extraEnv', async () => {
      const { processTurn } = await import('../../src/agent/turn.js')
      vi.mocked(processTurn).mockClear()

      const queue = new AsyncQueueImpl<InboundMessage>()
      const loop = new RunLoopImpl('receiver', queue, new Map(), makePai())

      const source = 'internal:agent:conv-xyz:sender-agent'
      queue.push({ source, content: 'ping' })
      queue.close()

      await loop.start()

      const callArg = vi.mocked(processTurn).mock.calls[0]![0]
      expect(callArg.extraEnv).toEqual({
        XAR_AGENT_ID: 'receiver',
        XAR_CONV_ID: extractConvId(source), // 'conv-xyz'
      })
    })

    it('does not create an outbound target for internal source (no xgw delivery)', async () => {
      // buildTarget returns null for internal → no Deliver object → no stream_start sent
      // We verify this indirectly: processTurn.tokenWriter should be null (no IPC conn)
      const { processTurn } = await import('../../src/agent/turn.js')
      vi.mocked(processTurn).mockClear()

      const queue = new AsyncQueueImpl<InboundMessage>()
      // No IPC connections
      const loop = new RunLoopImpl('receiver', queue, new Map(), makePai())

      queue.push({ source: 'internal:agent:conv-xyz:sender-agent', content: 'ping' })
      queue.close()

      await loop.start()

      const callArg = vi.mocked(processTurn).mock.calls[0]![0]
      // No IPC conn → chunkWriter is null → tokenWriter is null
      expect(callArg.tokenWriter).toBeNull()
    })

    it('does NOT warn about missing IPC connection for internal source', async () => {
      const warnSpy = vi.fn()
      const logger = {
        info: vi.fn(), warn: warnSpy, error: vi.fn(), debug: vi.fn(), close: async () => {},
      }

      const queue = new AsyncQueueImpl<InboundMessage>()
      const loop = new RunLoopImpl('receiver', queue, new Map(), makePai(), logger)

      queue.push({ source: 'internal:agent:conv-xyz:sender-agent', content: 'ping' })
      queue.close()

      await loop.start()

      const warns = warnSpy.mock.calls.map((c) => String(c[0]))
      expect(warns.some((m) => m.includes('No IPC connection'))).toBe(false)
    })
  })

  // ── Reply-back chain ──────────────────────────────────────────────────────

  describe('reply-back chain: receiver can construct reply source', () => {
    it('XAR_AGENT_ID + XAR_CONV_ID injected by run-loop enable buildInternalSource for reply', async () => {
      const { processTurn } = await import('../../src/agent/turn.js')
      vi.mocked(processTurn).mockClear()

      const queue = new AsyncQueueImpl<InboundMessage>()
      const loop = new RunLoopImpl('receiver', queue, new Map(), makePai())

      const inboundSource = 'internal:agent:conv-xyz:sender-agent'
      queue.push({ source: inboundSource, content: 'hello' })
      queue.close()

      await loop.start()

      // Simulate what the agent's bash_exec tool would do:
      // use the injected env vars to build a reply source
      const callArg = vi.mocked(processTurn).mock.calls[0]![0]
      const { XAR_AGENT_ID, XAR_CONV_ID } = callArg.extraEnv!

      process.env['XAR_AGENT_ID'] = XAR_AGENT_ID
      process.env['XAR_CONV_ID'] = XAR_CONV_ID

      const replySource = buildInternalSource({})

      // Reply source should identify receiver as sender, with same conv-id
      expect(replySource).toBe(`internal:agent:${XAR_CONV_ID}:${XAR_AGENT_ID}`)
      const parsed = parseSource(replySource)
      expect(parsed.sender_agent_id).toBe('receiver')
      expect(parsed.conversation_id).toBe('conv-xyz')
    })

    it('conv-id is preserved across the inbound→extraEnv→reply chain', async () => {
      const { processTurn } = await import('../../src/agent/turn.js')
      vi.mocked(processTurn).mockClear()

      const convId = 'my-special-conv'
      const queue = new AsyncQueueImpl<InboundMessage>()
      const loop = new RunLoopImpl('agent-b', queue, new Map(), makePai())

      queue.push({ source: `internal:agent:${convId}:agent-a`, content: 'msg' })
      queue.close()

      await loop.start()

      const { XAR_CONV_ID } = vi.mocked(processTurn).mock.calls[0]![0].extraEnv!
      expect(XAR_CONV_ID).toBe(convId)
    })
  })

  // ── Concurrent agents: isolation ─────────────────────────────────────────

  describe('message isolation between agents', () => {
    it('two agents receive independent extraEnv with their own agent IDs', async () => {
      const { processTurn } = await import('../../src/agent/turn.js')
      vi.mocked(processTurn).mockClear()

      const source = 'internal:agent:shared-conv:orchestrator'

      // Agent A
      const queueA = new AsyncQueueImpl<InboundMessage>()
      const loopA = new RunLoopImpl('agent-a', queueA, new Map(), makePai())
      queueA.push({ source, content: 'for A' })
      queueA.close()
      await loopA.start()

      // Agent B
      const queueB = new AsyncQueueImpl<InboundMessage>()
      const loopB = new RunLoopImpl('agent-b', queueB, new Map(), makePai())
      queueB.push({ source, content: 'for B' })
      queueB.close()
      await loopB.start()

      const calls = vi.mocked(processTurn).mock.calls
      expect(calls).toHaveLength(2)

      const envA = calls[0]![0].extraEnv!
      const envB = calls[1]![0].extraEnv!

      expect(envA['XAR_AGENT_ID']).toBe('agent-a')
      expect(envB['XAR_AGENT_ID']).toBe('agent-b')
      // Both share the same conv-id from the same source
      expect(envA['XAR_CONV_ID']).toBe('shared-conv')
      expect(envB['XAR_CONV_ID']).toBe('shared-conv')
    })
  })
})



// ── reply_to: auto-announce mechanism ────────────────────────────────────────

describe('reply_to auto-announce', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('announces result to reply_to agent when processTurn returns assistant text', async () => {
    const { processTurn } = await import('../../src/agent/turn.js')
    vi.mocked(processTurn).mockResolvedValue({
      newMessages: [{ role: 'assistant', content: 'task done' }],
    })

    const sendToAgent = vi.fn(() => true)
    const queue = new AsyncQueueImpl<InboundMessage>()
    const loop = new RunLoopImpl('worker', queue, new Map(), makePai(), undefined, sendToAgent)

    queue.push({
      source: 'internal:agent:conv-1:orchestrator',
      content: 'do the task',
      reply_to: 'agent:orchestrator',
    })
    queue.close()
    await loop.start()

    expect(sendToAgent).toHaveBeenCalledOnce()
    const [targetId, msg] = sendToAgent.mock.calls[0]!
    expect(targetId).toBe('orchestrator')
    expect(msg.content).toBe('task done')
    expect(msg.source).toBe('internal:agent:conv-1:worker')
    // reply_to must NOT be forwarded — chain terminates here
    expect(msg.reply_to).toBeUndefined()
  })

  it('does NOT announce when reply_to is absent', async () => {
    const { processTurn } = await import('../../src/agent/turn.js')
    vi.mocked(processTurn).mockResolvedValue({
      newMessages: [{ role: 'assistant', content: 'hello' }],
    })

    const sendToAgent = vi.fn(() => true)
    const queue = new AsyncQueueImpl<InboundMessage>()
    const loop = new RunLoopImpl('worker', queue, new Map(), makePai(), undefined, sendToAgent)

    // No reply_to — one-way message
    queue.push({ source: 'internal:agent:conv-1:orchestrator', content: 'notify only' })
    queue.close()
    await loop.start()

    expect(sendToAgent).not.toHaveBeenCalled()
  })

  it('does NOT announce when processTurn returns no assistant text', async () => {
    const { processTurn } = await import('../../src/agent/turn.js')
    vi.mocked(processTurn).mockResolvedValue({ newMessages: [] })

    const sendToAgent = vi.fn(() => true)
    const queue = new AsyncQueueImpl<InboundMessage>()
    const loop = new RunLoopImpl('worker', queue, new Map(), makePai(), undefined, sendToAgent)

    queue.push({
      source: 'internal:agent:conv-1:orchestrator',
      content: 'do task',
      reply_to: 'agent:orchestrator',
    })
    queue.close()
    await loop.start()

    expect(sendToAgent).not.toHaveBeenCalled()
  })

  it('orchestrator receiving worker reply does NOT re-announce (no reply_to on announce msg)', async () => {
    // This is the core loop-prevention test.
    // Worker announces to orchestrator — the announce msg has no reply_to.
    // Orchestrator processes it and should NOT call sendToAgent again.
    const { processTurn } = await import('../../src/agent/turn.js')
    vi.mocked(processTurn).mockResolvedValue({
      newMessages: [{ role: 'assistant', content: 'summary done' }],
    })

    const sendToAgent = vi.fn(() => true)
    const queue = new AsyncQueueImpl<InboundMessage>()
    const loop = new RunLoopImpl('orchestrator', queue, new Map(), makePai(), undefined, sendToAgent)

    // Simulates the auto-announce message from worker — no reply_to
    queue.push({
      source: 'internal:agent:conv-1:worker',
      content: 'task done',
      // no reply_to — chain terminates
    })
    queue.close()
    await loop.start()

    expect(sendToAgent).not.toHaveBeenCalled()
  })
})
