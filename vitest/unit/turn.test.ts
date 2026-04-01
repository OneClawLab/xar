import { describe, it, expect, vi } from 'vitest'
import { estimateChatInputTokens, computeInputBudget, processTurn } from '../../src/agent/turn.js'
import type { TurnCallbacks, TurnParams } from '../../src/agent/turn.js'
import type { ChatInput } from 'pai'

// ── estimateChatInputTokens ──────────────────────────────────────────────────

describe('estimateChatInputTokens', () => {
  it('returns > 0 for non-empty input', () => {
    const input: ChatInput = {
      system: 'You are helpful',
      history: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
      ],
      userMessage: 'how are you',
    }
    const tokens = estimateChatInputTokens(input)
    expect(tokens).toBeGreaterThan(0)
  })

  it('handles null/empty system and history', () => {
    const tokens = estimateChatInputTokens({ system: null, history: null, userMessage: 'hi' })
    expect(tokens).toBeGreaterThan(0)
  })

  it('includes history tokens — more history means more tokens', () => {
    const base: ChatInput = { system: 'sys', history: [], userMessage: 'msg' }
    const withHistory: ChatInput = {
      system: 'sys',
      history: [
        { role: 'user', content: 'a long message that adds tokens' },
        { role: 'assistant', content: 'another long message that adds tokens' },
      ],
      userMessage: 'msg',
    }
    expect(estimateChatInputTokens(withHistory)).toBeGreaterThan(estimateChatInputTokens(base))
  })

  it('handles non-string content (object) in history', () => {
    const input: ChatInput = {
      system: 'sys',
      history: [{ role: 'assistant', content: { key: 'value' } as any }],
      userMessage: 'msg',
    }
    const tokens = estimateChatInputTokens(input)
    expect(tokens).toBeGreaterThan(0)
  })
})

// ── computeInputBudget ───────────────────────────────────────────────────────

describe('computeInputBudget', () => {
  it('uses provided contextWindow and maxOutputTokens', () => {
    const result = computeInputBudget(64000, 2048)
    expect(result.contextWindow).toBe(64000)
    expect(result.maxOutputTokens).toBe(2048)
    expect(result.inputBudget).toBe(64000 - 2048 - 512)
  })

  it('falls back to 128K / 4096 when undefined', () => {
    const result = computeInputBudget(undefined, undefined)
    expect(result.contextWindow).toBe(128000)
    expect(result.maxOutputTokens).toBe(4096)
    expect(result.inputBudget).toBe(128000 - 4096 - 512)
  })

  it('falls back partially — contextWindow provided, maxOutputTokens undefined', () => {
    const result = computeInputBudget(32000, undefined)
    expect(result.contextWindow).toBe(32000)
    expect(result.maxOutputTokens).toBe(4096)
    expect(result.inputBudget).toBe(32000 - 4096 - 512)
  })
})

// ── processTurn ──────────────────────────────────────────────────────────────

// Mock compactSession so processTurn can run without real FS
vi.mock('pai', () => ({
  createBashExecTool: vi.fn(() => ({ name: 'bash_exec', description: 'exec', parameters: {}, handler: async () => ({}) })),
}))

vi.mock('../../src/agent/memory.js', () => ({
  compactSession: vi.fn(),
}))

import { compactSession as mockCompact } from '../../src/agent/memory.js'

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  close: async () => {},
}

function makeCallbacks(): TurnCallbacks & { calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = {}
  const track = (name: string) => (...args: unknown[]) => {
    if (!calls[name]) calls[name] = []
    calls[name]!.push(args)
  }
  return {
    calls,
    onCompactStart: track('onCompactStart'),
    onCompactEnd: track('onCompactEnd'),
    onCtxUsage: track('onCtxUsage'),
    onStreamStart: track('onStreamStart'),
    onStreamEnd: track('onStreamEnd'),
    onStreamError: track('onStreamError'),
    onThinkingDelta: track('onThinkingDelta'),
    onToolCall: track('onToolCall'),
    onToolResult: track('onToolResult'),
  }
}

/** Create a mock Pai instance whose chat() yields the given events */
function mockPai(chatImpl?: (...args: unknown[]) => AsyncGenerator<unknown>): import('pai').Pai {
  const defaultImpl = async function* () {
    yield { type: 'chat_end' as const, newMessages: [] }
  }
  return {
    chat: (chatImpl ?? defaultImpl) as any,
    getProviderInfo: vi.fn().mockResolvedValue({ name: 'test', contextWindow: 128000, maxTokens: 4096 }),
  }
}

function baseTurnParams(overrides?: Partial<TurnParams>): TurnParams {
  return {
    chatInput: { system: 'You are helpful', history: [{ role: 'user', content: 'hello' }], userMessage: 'hi' },
    pai: mockPai(),
    provider: 'test',
    model: 'test-model',
    stream: true,
    tokenWriter: null,
    sessionFile: '/tmp/test-session.jsonl',
    agentDir: '/tmp/test-agent',
    threadId: 'thread-1',
    maxAttempts: 1,
    logger: noopLogger,
    callbacks: makeCallbacks(),
    ...overrides,
  }
}

describe('processTurn', () => {
  it('sends ctx_usage based on chatInput history when not compacted', async () => {
    // compactSession returns not-compacted
    vi.mocked(mockCompact).mockResolvedValue({ compacted: false })

    const cbs = makeCallbacks()
    // Use a small context window so pct is meaningful with short messages
    await processTurn(baseTurnParams({
      pai: mockPai(async function* () {
        yield { type: 'chat_end' as const, newMessages: [{ role: 'assistant' as const, content: 'reply' }] }
      }),
      callbacks: cbs,
      contextWindow: 200,
      maxOutputTokens: 50,
    }))

    // onCtxUsage should have been called once
    expect(cbs.calls['onCtxUsage']).toHaveLength(1)
    const [totalTokens, budgetTokens, pct] = cbs.calls['onCtxUsage']![0]! as [number, number, number]
    expect(totalTokens).toBeGreaterThan(0)
    expect(budgetTokens).toBe(200 - 50 - 512) // may be negative but that's the math
    // Key assertion: totalTokens reflects actual chatInput content, not 0
    // (this was the original bug — reading from empty session file gave 0)
    expect(totalTokens).toBeGreaterThanOrEqual(5) // system + history + user ≥ a few tokens
  })

  it('uses provided contextWindow for budget calculation', async () => {
    vi.mocked(mockCompact).mockResolvedValue({ compacted: false })

    const cbs = makeCallbacks()
    await processTurn(baseTurnParams({
      pai: mockPai(),
      callbacks: cbs,
      contextWindow: 32000,
      maxOutputTokens: 2048,
    }))

    const [_total, budgetTokens] = cbs.calls['onCtxUsage']![0]! as [number, number, number]
    expect(budgetTokens).toBe(32000 - 2048 - 512)
  })

  it('uses default 128K context window when not provided', async () => {
    vi.mocked(mockCompact).mockResolvedValue({ compacted: false })

    const cbs = makeCallbacks()
    await processTurn(baseTurnParams({
      pai: mockPai(),
      callbacks: cbs,
      contextWindow: undefined,
      maxOutputTokens: undefined,
    }))

    const [_total, budgetTokens] = cbs.calls['onCtxUsage']![0]! as [number, number, number]
    expect(budgetTokens).toBe(128000 - 4096 - 512)
  })

  it('fires compact callbacks when compacted', async () => {
    vi.mocked(mockCompact).mockResolvedValue({
      compacted: true,
      reason: 'threshold',
      before_tokens: 10000,
      after_tokens: 5000,
      budget_tokens: 120000,
    })

    const cbs = makeCallbacks()
    await processTurn(baseTurnParams({ pai: mockPai(), callbacks: cbs }))

    expect(cbs.calls['onCompactStart']).toHaveLength(1)
    expect(cbs.calls['onCompactStart']![0]![0]).toBe('threshold')
    expect(cbs.calls['onCompactEnd']).toHaveLength(1)
    expect(cbs.calls['onCompactEnd']![0]).toEqual([10000, 5000])
    expect(cbs.calls['onCtxUsage']).toHaveLength(1)
    const [total, budget, pct] = cbs.calls['onCtxUsage']![0]! as [number, number, number]
    expect(total).toBe(5000)
    expect(budget).toBe(120000)
    expect(pct).toBe(Math.round((5000 / 120000) * 100))
  })

  it('returns newMessages from chat_end event', async () => {
    vi.mocked(mockCompact).mockResolvedValue({ compacted: false })
    const msgs = [
      { role: 'assistant' as const, content: 'hello' },
      { role: 'tool' as const, content: 'result', name: 'bash_exec' },
    ]

    const result = await processTurn(baseTurnParams({
      pai: mockPai(async function* () {
        yield { type: 'chat_end' as const, newMessages: msgs }
      }),
    }))
    expect(result.newMessages).toEqual(msgs)
  })

  it('calls onStreamError and throws on non-retryable LLM failure', async () => {
    vi.mocked(mockCompact).mockResolvedValue({ compacted: false })

    const cbs = makeCallbacks()
    await expect(processTurn(baseTurnParams({
      pai: mockPai(async function* () { throw new Error('invalid api key') }),
      callbacks: cbs,
    }))).rejects.toThrow('invalid api key')
    expect(cbs.calls['onStreamError']).toHaveLength(1)
    expect(cbs.calls['onStreamError']![0]![0]).toBe('invalid api key')
  })

  it('compact failure is non-fatal — ctx_usage is skipped but chat proceeds', async () => {
    vi.mocked(mockCompact).mockRejectedValue(new Error('disk full'))

    const cbs = makeCallbacks()
    const result = await processTurn(baseTurnParams({
      pai: mockPai(async function* () {
        yield { type: 'chat_end' as const, newMessages: [{ role: 'assistant' as const, content: 'ok' }] }
      }),
      callbacks: cbs,
    }))

    // ctx_usage not called (compact threw before it could)
    expect(cbs.calls['onCtxUsage']).toBeUndefined()
    // but chat still ran
    expect(result.newMessages).toHaveLength(1)
    expect(cbs.calls['onStreamEnd']).toHaveLength(1)
  })
})
