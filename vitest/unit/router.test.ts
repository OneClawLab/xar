/**
 * Unit tests for Router
 *
 * Source address format (ARCH.md):
 *   external:<channel_id>:<conversation_type>:<conversation_id>:<peer_id>
 *   internal:<conversation_type>:<conversation_id>:<sender_agent_id>
 *   self
 */

import { describe, it, expect } from 'vitest'
import { determineThreadId, parseSource } from '../../src/agent/router.js'
import type { AgentConfig } from '../../src/agent/types.js'

describe('Router', () => {
  const baseConfig: AgentConfig = {
    agent_id: 'test-agent',
    kind: 'user',
    pai: { provider: 'openai', model: 'gpt-4o' },
    routing: { default: 'per-peer' },
    memory: { compact_threshold_tokens: 8000, session_compact_threshold_tokens: 4000 },
    retry: { max_attempts: 3 },
  }

  describe('parseSource', () => {
    it('should parse external source', () => {
      const parsed = parseSource('external:telegram:main:dm:alice:alice')
      expect(parsed.kind).toBe('external')
      expect(parsed.channel_id).toBe('telegram:main')
      expect(parsed.conversation_type).toBe('dm')
      expect(parsed.conversation_id).toBe('alice')
      expect(parsed.peer_id).toBe('alice')
    })

    it('should parse internal source', () => {
      const parsed = parseSource('internal:dm:default:warden')
      expect(parsed.kind).toBe('internal')
      expect(parsed.conversation_type).toBe('dm')
      expect(parsed.conversation_id).toBe('default')
      expect(parsed.sender_agent_id).toBe('warden')
    })

    it('should parse self source', () => {
      const parsed = parseSource('self')
      expect(parsed.kind).toBe('self')
    })

    it('should throw on invalid source', () => {
      expect(() => parseSource('invalid')).toThrow()
    })

    it('should throw on empty string', () => {
      expect(() => parseSource('')).toThrow()
    })

    it('should throw on external with insufficient parts', () => {
      expect(() => parseSource('external:telegram:main')).toThrow()
      expect(() => parseSource('external:telegram:main:dm')).toThrow()
      expect(() => parseSource('external:telegram:main:dm:alice')).toThrow()
    })

    it('should throw on internal with insufficient parts', () => {
      expect(() => parseSource('internal:dm')).toThrow()
      expect(() => parseSource('internal:dm:default')).toThrow()
    })

    it('should handle sub-conversation with slash in conversation_id', () => {
      const parsed = parseSource('external:telegram:main:group:grp-123/topic-456:alice')
      expect(parsed.conversation_id).toBe('grp-123/topic-456')
      expect(parsed.peer_id).toBe('alice')
    })
  })

  describe('determineThreadId', () => {
    it('should route per-peer using peer_id from external source', () => {
      const config = { ...baseConfig, routing: { default: 'per-peer' as const } }
      const threadId = determineThreadId(config, 'external:telegram:main:dm:alice:alice')
      expect(threadId).toBe('peers/alice')
    })

    it('should route per-peer using sender_agent_id from internal source', () => {
      const config = { ...baseConfig, routing: { default: 'per-peer' as const } }
      const threadId = determineThreadId(config, 'internal:dm:default:warden')
      expect(threadId).toBe('peers/warden')
    })

    it('should route per-conversation using conversation_id', () => {
      const config = { ...baseConfig, routing: { default: 'per-conversation' as const } }
      const threadId = determineThreadId(config, 'external:telegram:main:group:grp-123:bob')
      expect(threadId).toBe('conversations/grp-123')
    })

    it('should route per-agent to main thread', () => {
      const config = { ...baseConfig, routing: { default: 'per-agent' as const } }
      const threadId = determineThreadId(config, 'external:telegram:main:dm:alice:alice')
      expect(threadId).toBe('main')
    })

    it('should be deterministic for same inputs', () => {
      const config = { ...baseConfig, routing: { default: 'per-peer' as const } }
      const source = 'external:telegram:main:dm:alice:alice'
      expect(determineThreadId(config, source)).toBe(determineThreadId(config, source))
    })

    it('should produce different thread IDs for different peers', () => {
      const config = { ...baseConfig, routing: { default: 'per-peer' as const } }
      const t1 = determineThreadId(config, 'external:telegram:main:dm:alice:alice')
      const t2 = determineThreadId(config, 'external:telegram:main:dm:bob:bob')
      expect(t1).not.toBe(t2)
    })

    it('should throw on unknown routing mode', () => {
      const config = { ...baseConfig, routing: { default: 'unknown-mode' as any } }
      expect(() => determineThreadId(config, 'external:telegram:main:dm:alice:alice')).toThrow()
    })
  })
})
