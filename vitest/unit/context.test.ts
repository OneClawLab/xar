/**
 * Unit tests for LLM context builder (src/agent/context.ts)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock getDaemonConfig before importing context
vi.mock('../../src/config.js', () => ({
  getDaemonConfig: () => ({ theClawHome: '/tmp/test-theclaw', ipcPort: 18792 }),
}))

// Mock fs for identity/memory loading
const mockReadFile = vi.fn()
vi.mock('fs', () => ({
  promises: {
    readFile: (...args: unknown[]) => mockReadFile(...args),
  },
}))

import { buildContext, loadIdentity } from '../../src/agent/context.js'
import type { AgentConfig } from '../../src/agent/types.js'
import type { InboundMessage } from '../../src/types.js'

function makeConfig(): AgentConfig {
  return {
    agent_id: 'admin',
    kind: 'system',
    pai: { provider: 'openai', model: 'gpt-4o' },
    routing: { default: 'per-peer' },
    memory: { compact_threshold_tokens: 8000, session_compact_threshold_tokens: 4000 },
    retry: { max_attempts: 3 },
  }
}

function makeMsg(source = 'external:telegram:main:dm:alice:alice'): InboundMessage {
  return { source, content: 'hello' }
}

function makeThreadStore(events: Array<{ source: string; type: string; content: string }> = []) {
  return {
    threadPath: '/tmp/test-thread',
    push: vi.fn(),
    pushBatch: vi.fn(),
    peek: vi.fn().mockResolvedValue(events.map((e, i) => ({ id: i + 1, created_at: '2026-01-01T00:00:00Z', ...e }))),
    close: vi.fn(),
  }
}

describe('loadIdentity', () => {
  beforeEach(() => { mockReadFile.mockReset() })

  it('returns IDENTITY.md content when file exists', async () => {
    mockReadFile.mockResolvedValue('You are the admin agent.')
    const identity = await loadIdentity('admin')
    expect(identity).toBe('You are the admin agent.')
    const calledPath = mockReadFile.mock.calls[0]![0] as string
    expect(calledPath).toContain('admin')
    expect(calledPath).toContain('IDENTITY.md')
  })

  it('returns default identity when file is missing', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'))
    const identity = await loadIdentity('admin')
    expect(identity).toContain('admin')
  })
})

describe('buildContext', () => {
  beforeEach(() => { mockReadFile.mockReset() })

  it('assembles system prompt from identity + memory', async () => {
    mockReadFile.mockImplementation(async (path: string) => {
      if (path.includes('IDENTITY.md')) return 'You are admin.'
      if (path.includes('agent.md')) return 'Agent-level fact.'
      if (path.includes('user-')) return 'Alice prefers concise answers.'
      if (path.includes('thread-')) return 'Previous topic: weather.'
      throw new Error('ENOENT')
    })

    const store = makeThreadStore([
      { source: 'external:telegram:main:dm:alice:alice', type: 'message', content: 'hi' },
    ])

    const ctx = await buildContext('admin', makeConfig(), store as any, makeMsg(), 'peers/alice')
    expect(ctx.system).toContain('You are admin.')
    expect(ctx.userMessage).toBe('hello')
    expect(ctx.history).toHaveLength(1)
    expect(ctx.history[0]!.role).toBe('user')
  })

  it('converts thread record events to assistant messages', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'))

    const store = makeThreadStore([
      { source: 'external:telegram:main:dm:alice:alice', type: 'message', content: 'hi' },
      { source: 'self', type: 'record', content: JSON.stringify({ content: 'hello back' }) },
    ])

    const ctx = await buildContext('admin', makeConfig(), store as any, makeMsg(), 'peers/alice')
    expect(ctx.history).toHaveLength(2)
    expect(ctx.history[0]!.role).toBe('user')
    expect(ctx.history[1]!.role).toBe('assistant')
    expect(ctx.history[1]!.content).toBe('hello back')
  })

  it('converts tool record events to tool messages', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'))

    const store = makeThreadStore([
      { source: 'tool:bash_exec', type: 'record', content: JSON.stringify({ content: 'ls output', tool_call_id: 'tc1', name: 'bash_exec' }) },
    ])

    const ctx = await buildContext('admin', makeConfig(), store as any, makeMsg(), 'peers/alice')
    expect(ctx.history).toHaveLength(1)
    expect(ctx.history[0]!.role).toBe('tool')
    expect((ctx.history[0] as any).name).toBe('bash_exec')
  })

  it('handles empty thread history', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'))
    const store = makeThreadStore([])
    const ctx = await buildContext('admin', makeConfig(), store as any, makeMsg(), 'main')
    expect(ctx.history).toHaveLength(0)
    expect(ctx.userMessage).toBe('hello')
  })
})
