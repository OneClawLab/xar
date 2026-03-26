import { describe, it, expect } from 'vitest'
import { shouldCompact, estimateTotalTokens } from '../../src/agent/memory.js'

describe('memory', () => {
  describe('shouldCompact', () => {
    it('should trigger when context usage exceeds threshold', () => {
      const state = { turnCount: 5, lastCompactedAt: 0 }
      const inputBudget = 1000
      const totalTokens = 850 // 85% of budget

      const result = shouldCompact(totalTokens, inputBudget, state)
      expect(result).toBe(true)
    })

    it('should trigger when interval exceeds threshold', () => {
      const state = { turnCount: 15, lastCompactedAt: 0 }
      const inputBudget = 1000
      const totalTokens = 500 // 50% of budget

      const result = shouldCompact(totalTokens, inputBudget, state)
      expect(result).toBe(true)
    })

    it('should not trigger when both conditions are not met', () => {
      const state = { turnCount: 5, lastCompactedAt: 0 }
      const inputBudget = 1000
      const totalTokens = 500 // 50% of budget

      const result = shouldCompact(totalTokens, inputBudget, state)
      expect(result).toBe(false)
    })
  })

  describe('estimateTotalTokens', () => {
    it('should sum system, session, and user tokens', () => {
      const systemPrompt = 'You are helpful'
      const sessionMessages = [
        { role: 'user' as const, content: 'hello' },
        { role: 'assistant' as const, content: 'hi' },
      ]
      const userMessage = 'how are you'

      const total = estimateTotalTokens(systemPrompt, sessionMessages, userMessage)

      expect(total).toBeGreaterThan(0)
      // Should include overhead from all parts
      expect(total).toBeGreaterThan(10)
    })
  })
})
