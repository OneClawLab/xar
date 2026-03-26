/**
 * Unit tests for memory compaction logic (session.ts + memory.ts)
 */

import { describe, it, expect } from 'vitest'
import {
  estimateTokens,
  estimateMessageTokens,
  splitMessages,
  buildTranscript,
  type SessionMessage,
} from '../../src/agent/session.js'
import { shouldCompact, estimateTotalTokens } from '../../src/agent/memory.js'

describe('estimateTokens', () => {
  it('returns positive value for non-empty string', () => {
    expect(estimateTokens('Hello world')).toBeGreaterThan(0)
  })

  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('counts CJK characters as more tokens than ASCII', () => {
    const cjk = estimateTokens('你好世界')
    const ascii = estimateTokens('abcd') // same char count
    expect(cjk).toBeGreaterThan(ascii)
  })
})

describe('shouldCompact', () => {
  it('returns true when token usage exceeds 80% of budget', () => {
    expect(shouldCompact(8100, 10000, { turnCount: 1, lastCompactedAt: 0 })).toBe(true)
  })

  it('returns false when under threshold and interval', () => {
    expect(shouldCompact(5000, 10000, { turnCount: 3, lastCompactedAt: 0 })).toBe(false)
  })

  it('returns true when turn interval exceeded', () => {
    expect(shouldCompact(1000, 10000, { turnCount: 15, lastCompactedAt: 5 })).toBe(true)
  })

  it('returns false when just under interval', () => {
    expect(shouldCompact(1000, 10000, { turnCount: 9, lastCompactedAt: 0 })).toBe(false)
  })
})

describe('estimateTotalTokens', () => {
  it('sums system prompt, session messages, and user message tokens', () => {
    const msgs: SessionMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]
    const total = estimateTotalTokens('You are a helpful assistant.', msgs, 'What is 2+2?')
    expect(total).toBeGreaterThan(0)
  })

  it('returns positive for empty session', () => {
    const total = estimateTotalTokens('system', [], 'user msg')
    expect(total).toBeGreaterThan(0)
  })
})

describe('splitMessages', () => {
  it('puts recent messages in recentRaw within budget', () => {
    const msgs: SessionMessage[] = [
      { role: 'user', content: 'msg1' },
      { role: 'assistant', content: 'reply1' },
      { role: 'user', content: 'msg2' },
      { role: 'assistant', content: 'reply2' },
    ]
    const { toSummarize, recentRaw } = splitMessages(msgs, 10000)
    // With a large budget, all messages should be in recentRaw
    expect(recentRaw).toHaveLength(4)
    expect(toSummarize).toHaveLength(0)
  })

  it('splits when budget is tight', () => {
    const msgs: SessionMessage[] = []
    for (let i = 0; i < 20; i++) {
      msgs.push({ role: 'user', content: `This is message number ${i} with some content` })
      msgs.push({ role: 'assistant', content: `This is reply number ${i} with some content` })
    }
    const { toSummarize, recentRaw } = splitMessages(msgs, 50)
    expect(toSummarize.length).toBeGreaterThan(0)
    expect(recentRaw.length).toBeGreaterThan(0)
    expect(toSummarize.length + recentRaw.length).toBe(40)
  })
})

describe('buildTranscript', () => {
  it('formats user and assistant messages with turn numbers', () => {
    const msgs: SessionMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ]
    const transcript = buildTranscript(msgs)
    expect(transcript).toContain('[Turn 1]')
    expect(transcript).toContain('User: Hello')
    expect(transcript).toContain('Assistant: Hi there')
  })

  it('formats tool messages', () => {
    const msgs: SessionMessage[] = [
      { role: 'tool', content: 'output', name: 'bash' },
    ]
    const transcript = buildTranscript(msgs)
    expect(transcript).toContain('Tool result (bash): output')
  })
})
