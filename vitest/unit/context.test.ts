/**
 * Unit tests for LLM context builder (src/agent/context.ts)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock getDaemonConfig before importing context
vi.mock('../../src/config.js', () => ({
  getDaemonConfig: () => ({ theClawHome: '/tmp/test-theclaw', ipcPort: 29211 }),
}))

// Mock fs for identity/memory loading
const mockReadFile = vi.fn()
vi.mock('fs', () => ({
  promises: {
    readFile: (...args: unknown[]) => mockReadFile(...args),
  },
}))

import { buildContext, loadIdentity, buildCommunicationContext } from '../../src/agent/context.js'
import type { AgentConfig } from '../../src/agent/types.js'
import type { InboundMessage } from '../../src/types.js'
import type { TaskSummaryContext } from '../../src/agent/context.js'

function makeConfig(): AgentConfig {
  return {
    agent_id: 'admin',
    kind: 'system',
    pai: { provider: 'openai', model: 'gpt-4o' },
    routing: { mode: 'reactive', trigger: 'mention' },
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
    expect(ctx.history ?? []).toHaveLength(1)
    expect((ctx.history ?? [])[0]!.role).toBe('user')
  })

  it('converts thread record events to assistant messages', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'))

    const store = makeThreadStore([
      { source: 'external:telegram:main:dm:alice:alice', type: 'message', content: 'hi' },
      { source: 'self', type: 'record', content: JSON.stringify({ content: 'hello back' }) },
    ])

    const ctx = await buildContext('admin', makeConfig(), store as any, makeMsg(), 'peers/alice')
    const history = ctx.history ?? []
    expect(history).toHaveLength(2)
    expect(history[0]!.role).toBe('user')
    expect(history[1]!.role).toBe('assistant')
    expect(history[1]!.content).toBe('hello back')
  })

  it('converts tool record events to tool messages', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'))

    const store = makeThreadStore([
      { source: 'tool:bash_exec', type: 'record', content: JSON.stringify({ content: 'ls output', tool_call_id: 'tc1', name: 'bash_exec' }) },
    ])

    const ctx = await buildContext('admin', makeConfig(), store as any, makeMsg(), 'peers/alice')
    const history = ctx.history ?? []
    expect(history).toHaveLength(1)
    expect(history[0]!.role).toBe('tool')
    expect((history[0] as any).name).toBe('bash_exec')
  })

  it('handles empty thread history', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'))
    const store = makeThreadStore([])
    const ctx = await buildContext('admin', makeConfig(), store as any, makeMsg(), 'main')
    expect(ctx.history ?? []).toHaveLength(0)
    expect(ctx.userMessage).toBe('hello')
  })
})

// ─── buildCommunicationContext unit tests ────────────────────────────────────

function makeReactiveConfig(): AgentConfig {
  return {
    agent_id: 'admin',
    kind: 'system',
    pai: { provider: 'openai', model: 'gpt-4o' },
    routing: { mode: 'reactive', trigger: 'mention' },
    memory: { compact_threshold_tokens: 8000, session_compact_threshold_tokens: 4000 },
    retry: { max_attempts: 3 },
  }
}

function makeAutonomousConfig(): AgentConfig {
  return {
    ...makeReactiveConfig(),
    routing: { mode: 'autonomous', trigger: 'all' },
  }
}

function makeExternalDmMsg(peerId = 'alice'): InboundMessage {
  return { source: `external:telegram:main:dm:${peerId}:${peerId}`, content: 'hello' }
}

function makeInternalMsg(taskId = 'admin-t1', sender = 'analyst', replyTo?: string): InboundMessage {
  return {
    source: `internal:task:${taskId}:${sender}`,
    content: 'task result',
    ...(replyTo ? { reply_to: replyTo } : {}),
  }
}

function makeSimpleThreadStore() {
  return { peek: vi.fn(async () => []) }
}

describe('buildCommunicationContext', () => {
  // Scenario A: front-reactive
  it('Scenario A: contains agent identity and peer info', async () => {
    const ctx = await buildCommunicationContext(
      'admin',
      makeExternalDmMsg('alice'),
      makeReactiveConfig(),
      makeSimpleThreadStore() as any,
      ['analyst'],
    )
    expect(ctx).toContain('You are: agent:admin')
    expect(ctx).toContain('peer:alice')
  })

  it('Scenario A: contains reply target for peer', async () => {
    const ctx = await buildCommunicationContext(
      'admin',
      makeExternalDmMsg('alice'),
      makeReactiveConfig(),
      makeSimpleThreadStore() as any,
      [],
    )
    expect(ctx).toContain('Your text response will be delivered to')
    expect(ctx).toContain('peer:alice')
  })

  it('Scenario A: contains available agents list', async () => {
    const ctx = await buildCommunicationContext(
      'admin',
      makeExternalDmMsg('alice'),
      makeReactiveConfig(),
      makeSimpleThreadStore() as any,
      ['analyst', 'researcher'],
    )
    expect(ctx).toContain('agent:analyst')
    expect(ctx).toContain('agent:researcher')
  })

  // Scenario B: front-autonomous
  it('Scenario B: contains "You decide whether to respond"', async () => {
    const ctx = await buildCommunicationContext(
      'admin',
      makeExternalDmMsg('alice'),
      makeAutonomousConfig(),
      makeSimpleThreadStore() as any,
      [],
    )
    expect(ctx).toContain('You decide whether to respond')
  })

  it('Scenario B: contains agent identity', async () => {
    const ctx = await buildCommunicationContext(
      'admin',
      makeExternalDmMsg('alice'),
      makeAutonomousConfig(),
      makeSimpleThreadStore() as any,
      [],
    )
    expect(ctx).toContain('You are: agent:admin')
  })

  // Scenario C: worker
  it('Scenario C: contains "DO NOT use send_message to reply"', async () => {
    const msg = makeInternalMsg('admin-t1', 'admin', 'agent:admin')
    const ctx = await buildCommunicationContext(
      'analyst',
      msg,
      makeReactiveConfig(),
      makeSimpleThreadStore() as any,
      [],
      { hasPendingTasks: false, isSummaryTurn: false },
    )
    expect(ctx).toContain('DO NOT use send_message to reply')
  })

  it('Scenario C: contains "Delegated by"', async () => {
    const msg = makeInternalMsg('admin-t1', 'admin', 'agent:admin')
    const ctx = await buildCommunicationContext(
      'analyst',
      msg,
      makeReactiveConfig(),
      makeSimpleThreadStore() as any,
      [],
      { hasPendingTasks: false, isSummaryTurn: false },
    )
    expect(ctx).toContain('Delegated by')
  })

  // Scenario D: worker-synthesizing
  it('Scenario D: contains "Synthesize the results"', async () => {
    const msg: InboundMessage = { ...makeInternalMsg('admin-t1', 'admin', 'agent:admin') }
    const taskCtx: TaskSummaryContext = {
      hasPendingTasks: false,
      isSummaryTurn: true,
      subtaskResults: [{ worker: 'sub1', instruction: 'do x', result: 'done x', status: 'done' }],
    }
    const ctx = await buildCommunicationContext(
      'analyst',
      msg,
      makeReactiveConfig(),
      makeSimpleThreadStore() as any,
      [],
      taskCtx,
    )
    expect(ctx).toContain('Synthesize the results')
  })

  it('Scenario D: contains "Do NOT delegate further"', async () => {
    const msg: InboundMessage = { ...makeInternalMsg('admin-t1', 'admin', 'agent:admin') }
    const taskCtx: TaskSummaryContext = {
      hasPendingTasks: false,
      isSummaryTurn: true,
      subtaskResults: [{ worker: 'sub1', instruction: 'do x', result: 'done x', status: 'done' }],
    }
    const ctx = await buildCommunicationContext(
      'analyst',
      msg,
      makeReactiveConfig(),
      makeSimpleThreadStore() as any,
      [],
      taskCtx,
    )
    expect(ctx).toContain('Do NOT delegate further')
  })

  // Scenario E: orchestrator-synthesizing
  it('Scenario E: contains Task ID', async () => {
    const msg = makeInternalMsg('admin-t1', 'analyst') // no reply_to → orchestrator
    const taskCtx: TaskSummaryContext = {
      hasPendingTasks: false,
      isSummaryTurn: true,
      taskId: 'admin-t1',
      replyTarget: 'peer:alice',
      subtaskResults: [{ worker: 'analyst', instruction: 'do y', result: 'done y', status: 'done' }],
    }
    const ctx = await buildCommunicationContext(
      'admin',
      msg,
      makeReactiveConfig(),
      makeSimpleThreadStore() as any,
      [],
      taskCtx,
    )
    expect(ctx).toContain('Task ID')
    expect(ctx).toContain('admin-t1')
  })

  it('Scenario E: contains "All subtasks completed"', async () => {
    const msg = makeInternalMsg('admin-t1', 'analyst')
    const taskCtx: TaskSummaryContext = {
      hasPendingTasks: false,
      isSummaryTurn: true,
      taskId: 'admin-t1',
      replyTarget: 'peer:alice',
      subtaskResults: [{ worker: 'analyst', instruction: 'do y', result: 'done y', status: 'done' }],
    }
    const ctx = await buildCommunicationContext(
      'admin',
      msg,
      makeReactiveConfig(),
      makeSimpleThreadStore() as any,
      [],
      taskCtx,
    )
    expect(ctx).toContain('All subtasks completed')
  })

  // Scenario F: orchestrator-waiting
  it('Scenario F: contains "Waiting for subtasks"', async () => {
    const taskCtx: TaskSummaryContext = {
      hasPendingTasks: true,
      isSummaryTurn: false,
      taskId: 'admin-t2',
      subtaskResults: [{ worker: 'analyst', instruction: 'do z', status: 'sent' }],
    }
    const ctx = await buildCommunicationContext(
      'admin',
      makeExternalDmMsg('alice'),
      makeReactiveConfig(),
      makeSimpleThreadStore() as any,
      [],
      taskCtx,
    )
    expect(ctx).toContain('Waiting for subtasks')
  })

  it('Scenario F: contains "progress update"', async () => {
    const taskCtx: TaskSummaryContext = {
      hasPendingTasks: true,
      isSummaryTurn: false,
      taskId: 'admin-t2',
      subtaskResults: [{ worker: 'analyst', instruction: 'do z', status: 'sent' }],
    }
    const ctx = await buildCommunicationContext(
      'admin',
      makeExternalDmMsg('alice'),
      makeReactiveConfig(),
      makeSimpleThreadStore() as any,
      [],
      taskCtx,
    )
    expect(ctx).toContain('progress update')
  })

  // All scenarios: receive_user_update at the end
  it('all scenarios: contain receive_user_update explanation', async () => {
    const scenarios = [
      // A
      buildCommunicationContext('admin', makeExternalDmMsg(), makeReactiveConfig(), makeSimpleThreadStore() as any, []),
      // B
      buildCommunicationContext('admin', makeExternalDmMsg(), makeAutonomousConfig(), makeSimpleThreadStore() as any, []),
      // C
      buildCommunicationContext('analyst', makeInternalMsg('t1', 'admin', 'agent:admin'), makeReactiveConfig(), makeSimpleThreadStore() as any, [], { hasPendingTasks: false, isSummaryTurn: false }),
      // D
      buildCommunicationContext('analyst', makeInternalMsg('t1', 'admin', 'agent:admin'), makeReactiveConfig(), makeSimpleThreadStore() as any, [], { hasPendingTasks: false, isSummaryTurn: true, subtaskResults: [] }),
      // E
      buildCommunicationContext('admin', makeInternalMsg('t1', 'analyst'), makeReactiveConfig(), makeSimpleThreadStore() as any, [], { hasPendingTasks: false, isSummaryTurn: true, taskId: 't1', replyTarget: 'peer:alice', subtaskResults: [] }),
      // F
      buildCommunicationContext('admin', makeExternalDmMsg(), makeReactiveConfig(), makeSimpleThreadStore() as any, [], { hasPendingTasks: true, isSummaryTurn: false, taskId: 't2', subtaskResults: [] }),
    ]

    const results = await Promise.all(scenarios)
    for (const ctx of results) {
      expect(ctx).toContain('receive_user_update')
    }
  })
})
