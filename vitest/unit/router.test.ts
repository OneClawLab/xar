/**
 * Unit tests for Router
 */

import { describe, it, expect } from 'vitest'
import { determineThreadId } from '../../src/agent/router.js'
import type { AgentConfig } from '../../src/agent/types.js'
import type { InboundMessage } from '../../src/types.js'

describe('Router', () => {
  const baseConfig: AgentConfig = {
    agent_id: 'test-agent',
    kind: 'user',
    pai: { provider: 'openai', model: 'gpt-4o' },
    routing: { default: 'per-peer' },
    memory: { compact_threshold_tokens: 8000, session_compact_threshold_tokens: 4000 },
    retry: { max_attempts: 3 },
  }

  it('should determine per-peer thread ID correctly', () => {
    const config = { ...baseConfig, routing: { default: 'per-peer' } }
    const threadId = determineThreadId(config, 'peer:user-123')
    expect(threadId).toBe('peer-user-123')
  })

  it('should determine per-session thread ID correctly', () => {
    const config = { ...baseConfig, routing: { default: 'per-session' } }
    const threadId = determineThreadId(config, 'session:sess-456')
    expect(threadId).toBe('session-sess-456')
  })

  it('should determine per-agent thread ID correctly', () => {
    const config = { ...baseConfig, routing: { default: 'per-agent' } }
    const threadId = determineThreadId(config, 'peer:user-123')
    expect(threadId).toBe('main')
  })

  it('should be deterministic for same inputs', () => {
    const config = { ...baseConfig, routing: { default: 'per-peer' } }
    const threadId1 = determineThreadId(config, 'peer:user-123')
    const threadId2 = determineThreadId(config, 'peer:user-123')
    expect(threadId1).toBe(threadId2)
  })

  it('should produce different thread IDs for different peer IDs', () => {
    const config = { ...baseConfig, routing: { default: 'per-peer' } }
    const threadId1 = determineThreadId(config, 'peer:user-1')
    const threadId2 = determineThreadId(config, 'peer:user-2')

    expect(threadId1).not.toBe(threadId2)
    expect(threadId1).toContain('user-1')
    expect(threadId2).toContain('user-2')
  })

  it('should throw on invalid source format', () => {
    const config = { ...baseConfig, routing: { default: 'per-peer' } }
    expect(() => determineThreadId(config, 'invalid-format')).toThrow()
  })

  it('should throw on unknown routing mode', () => {
    const config = { ...baseConfig, routing: { default: 'unknown-mode' as any } }
    expect(() => determineThreadId(config, 'peer:user-123')).toThrow()
  })
})
