import { describe, it, expect } from 'vitest'
import {
  estimateTokens,
  estimateMessageTokens,
  splitMessages,
  buildTranscript,
  type SessionMessage,
} from '../../src/agent/session.js'

describe('session', () => {
  describe('estimateTokens', () => {
    it('should estimate ASCII tokens correctly', () => {
      // ASCII: ~0.25 tokens/char, so 4 chars = 1 token
      const tokens = estimateTokens('hello')
      expect(tokens).toBe(2) // 5 chars * 0.25 = 1.25, ceil = 2
    })

    it('should estimate CJK tokens correctly', () => {
      // CJK: ~1.5 tokens/char
      const tokens = estimateTokens('你好')
      expect(tokens).toBe(3) // 2 chars * 1.5 = 3
    })

    it('should handle mixed content', () => {
      const tokens = estimateTokens('hello你好')
      // 5 ASCII chars * 0.25 + 2 CJK chars * 1.5 = 1.25 + 3 = 4.25, ceil = 5
      expect(tokens).toBe(5)
    })
  })

  describe('estimateMessageTokens', () => {
    it('should include message overhead', () => {
      const msg: SessionMessage = {
        role: 'user',
        content: 'hello',
      }
      const tokens = estimateMessageTokens(msg)
      // 5 chars * 0.25 + 4 overhead = 1.25 + 4 = 5.25, ceil = 6
      expect(tokens).toBe(6)
    })
  })

  describe('splitMessages', () => {
    it('should split messages by token budget', () => {
      const messages: SessionMessage[] = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'world' },
        { role: 'user', content: 'test' },
      ]

      const { toSummarize, recentRaw } = splitMessages(messages, 10)

      // recentRaw should contain newest messages up to budget
      expect(recentRaw.length).toBeGreaterThan(0)
      expect(toSummarize.length).toBeGreaterThan(0)
      expect(recentRaw.length + toSummarize.length).toBe(messages.length)
    })

    it('should exclude system messages', () => {
      const messages: SessionMessage[] = [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'hello' },
      ]

      const { toSummarize, recentRaw } = splitMessages(messages, 100)

      // System message should not be in either group
      expect(recentRaw.every((m) => m.role !== 'system')).toBe(true)
      expect(toSummarize.every((m) => m.role !== 'system')).toBe(true)
    })
  })

  describe('buildTranscript', () => {
    it('should build transcript from messages', () => {
      const messages: SessionMessage[] = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
        { role: 'user', content: 'how are you' },
      ]

      const transcript = buildTranscript(messages)

      expect(transcript).toContain('[Turn 1]')
      expect(transcript).toContain('User: hello')
      expect(transcript).toContain('Assistant: hi there')
      expect(transcript).toContain('[Turn 2]')
    })

    it('should handle tool calls', () => {
      const messages: SessionMessage[] = [
        { role: 'user', content: 'run bash' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ name: 'bash_exec', arguments: { command: 'ls' } }],
        },
        { role: 'tool', content: 'file1.txt', name: 'bash_exec' },
      ]

      const transcript = buildTranscript(messages)

      expect(transcript).toContain('bash_exec')
      expect(transcript).toContain('Tool result')
    })

    it('should format tool result messages', () => {
      const messages: SessionMessage[] = [
        { role: 'tool', content: 'output', name: 'bash' },
      ]
      const transcript = buildTranscript(messages)
      expect(transcript).toContain('Tool result (bash): output')
    })
  })

  describe('splitMessages - large dataset', () => {
    it('should split correctly when budget is tight', () => {
      const messages: SessionMessage[] = []
      for (let i = 0; i < 20; i++) {
        messages.push({ role: 'user', content: `This is message number ${i} with some content` })
        messages.push({ role: 'assistant', content: `This is reply number ${i} with some content` })
      }
      const { toSummarize, recentRaw } = splitMessages(messages, 50)
      expect(toSummarize.length).toBeGreaterThan(0)
      expect(recentRaw.length).toBeGreaterThan(0)
      expect(toSummarize.length + recentRaw.length).toBe(40)
    })

    it('should put all messages in recentRaw when budget is large', () => {
      const messages: SessionMessage[] = [
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'reply1' },
        { role: 'user', content: 'msg2' },
        { role: 'assistant', content: 'reply2' },
      ]
      const { toSummarize, recentRaw } = splitMessages(messages, 10000)
      expect(recentRaw).toHaveLength(4)
      expect(toSummarize).toHaveLength(0)
    })
  })
})
