import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { InboundMessage } from '../../src/types.js'
import type { IpcConnection } from '../../src/ipc/types.js'

// ── Module mocks (hoisted) ────────────────────────────────────────────────────

vi.mock('../../src/agent/config.js', () => ({
  loadAgentConfig: vi.fn(async () => ({
    agent_id: 'agent1',
    kind: 'user',
    pai: { provider: 'anthropic', model: 'claude-3' },
    routing: { default: 'per-peer' },
    memory: { compact_threshold_tokens: 1000, session_compact_threshold_tokens: 500 },
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConn(): IpcConnection {
  return {
    id: 'conn1',
    send: vi.fn(async () => {}),
    close: vi.fn(),
  }
}

function makePai() {
  return {
    getProviderInfo: vi.fn(async () => ({ contextWindow: 100000, maxTokens: 4096 })),
  } as any
}

/** Subclass that exposes the private buildTarget method for testing */
class TestableRunLoop extends RunLoopImpl {
  exposeBuildTarget(source: string) {
    // @ts-expect-error accessing private method for testing
    return this.buildTarget(source) as ReturnType<RunLoopImpl['buildTarget']>
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('RunLoopImpl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('stop() closes the queue and resolves start()', async () => {
    const queue = new AsyncQueueImpl<InboundMessage>()
    const conns = new Map([['c1', makeConn()]])
    const loop = new RunLoopImpl('agent1', queue, conns)

    const startPromise = loop.start()
    await loop.stop()
    await expect(startPromise).resolves.toBeUndefined()
  })

  it('start() resolves immediately when queue is already closed', async () => {
    const queue = new AsyncQueueImpl<InboundMessage>()
    queue.close()
    const conns = new Map([['c1', makeConn()]])
    const loop = new RunLoopImpl('agent1', queue, conns)
    await expect(loop.start()).resolves.toBeUndefined()
  })

  it('stop() is idempotent — calling twice does not throw', async () => {
    const queue = new AsyncQueueImpl<InboundMessage>()
    const conns = new Map([['c1', makeConn()]])
    const loop = new RunLoopImpl('agent1', queue, conns)
    const startPromise = loop.start()
    await loop.stop()
    await expect(loop.stop()).resolves.toBeUndefined()
    await startPromise
  })

  describe('buildTarget()', () => {
    it('returns null for internal source', () => {
      const queue = new AsyncQueueImpl<InboundMessage>()
      const loop = new TestableRunLoop('agent1', queue, new Map())
      expect(loop.exposeBuildTarget('internal:agent:conv-abc:evolver')).toBeNull()
    })

    it('returns null for self source', () => {
      const queue = new AsyncQueueImpl<InboundMessage>()
      const loop = new TestableRunLoop('agent1', queue, new Map())
      expect(loop.exposeBuildTarget('self')).toBeNull()
    })

    it('returns OutboundTarget for valid external source', () => {
      const queue = new AsyncQueueImpl<InboundMessage>()
      const loop = new TestableRunLoop('agent1', queue, new Map())
      const result = loop.exposeBuildTarget('external:cli:default:dm:user1:user1')
      expect(result).toEqual({
        channel_id: 'cli:default',
        conversation_id: 'user1',
        peer_id: 'user1',
      })
    })
  })

  describe('no-connection warning suppression for internal source', () => {
    it('does NOT warn when processing internal source with no IPC connection', async () => {
      const warnSpy = vi.fn()
      const logger = {
        info: vi.fn(),
        warn: warnSpy,
        error: vi.fn(),
        debug: vi.fn(),
        close: async () => {},
      }

      const queue = new AsyncQueueImpl<InboundMessage>()
      // No IPC connections
      const loop = new RunLoopImpl('agent1', queue, new Map(), makePai(), logger)

      queue.push({ source: 'internal:agent:conv-abc:evolver', content: 'hello from agent' })
      queue.close()

      await loop.start()

      const warnCalls = warnSpy.mock.calls.map((c) => String(c[0]))
      expect(warnCalls.some((m) => m.includes('No IPC connection available'))).toBe(false)
    })

    it('DOES warn when processing external source with no IPC connection', async () => {
      const warnSpy = vi.fn()
      const logger = {
        info: vi.fn(),
        warn: warnSpy,
        error: vi.fn(),
        debug: vi.fn(),
        close: async () => {},
      }

      const queue = new AsyncQueueImpl<InboundMessage>()
      const loop = new RunLoopImpl('agent1', queue, new Map(), makePai(), logger)

      queue.push({ source: 'external:cli:default:dm:user1:user1', content: 'hello' })
      queue.close()

      await loop.start()

      const warnCalls = warnSpy.mock.calls.map((c) => String(c[0]))
      expect(warnCalls.some((m) => m.includes('No IPC connection available'))).toBe(true)
    })
  })
})

  describe('extraEnv injection into processTurn', () => {
    it('passes XAR_AGENT_ID and XAR_CONV_ID derived from source to processTurn', async () => {
      const { processTurn } = await import('../../src/agent/turn.js')
      const { extractConvId } = await import('../../src/agent/router.js')
      vi.mocked(processTurn).mockClear()

      const queue = new AsyncQueueImpl<InboundMessage>()
      const loop = new RunLoopImpl('my-agent', queue, new Map(), makePai())

      // external source: convId = conversation_id field = 'conv-42'
      const source = 'external:tui:main:dm:conv-42:peer-1'
      queue.push({ source, content: 'hello' })
      queue.close()

      await loop.start()

      expect(vi.mocked(processTurn)).toHaveBeenCalledOnce()
      const callArg = vi.mocked(processTurn).mock.calls[0]![0]
      expect(callArg.extraEnv).toEqual({
        XAR_AGENT_ID: 'my-agent',
        XAR_CONV_ID: extractConvId(source),
      })
    })

    it('XAR_CONV_ID is empty string for internal source (no conversation_id)', async () => {
      const { processTurn } = await import('../../src/agent/turn.js')
      vi.mocked(processTurn).mockClear()

      const queue = new AsyncQueueImpl<InboundMessage>()
      const loop = new RunLoopImpl('agent-x', queue, new Map(), makePai())

      // internal source: extractConvId returns conversation_id = 'conv-abc'
      const source = 'internal:agent:conv-abc:sender-agent'
      queue.push({ source, content: 'ping' })
      queue.close()

      await loop.start()

      expect(vi.mocked(processTurn)).toHaveBeenCalledOnce()
      const callArg = vi.mocked(processTurn).mock.calls[0]![0]
      expect(callArg.extraEnv).toMatchObject({
        XAR_AGENT_ID: 'agent-x',
        XAR_CONV_ID: 'conv-abc',
      })
    })
  })
