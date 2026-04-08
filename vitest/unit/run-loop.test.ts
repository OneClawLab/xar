import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { IpcConnection } from '../../src/ipc/types.js'

vi.mock('../../src/agent/config.js', () => ({
  loadAgentConfig: vi.fn(async () => ({
    agent_id: 'agent1',
    kind: 'user',
    pai: { provider: 'anthropic', model: 'claude-3' },
    routing: { mode: 'reactive', trigger: 'mention' },
    memory: { compact_threshold_tokens: 1000, session_compact_threshold_tokens: 500 },
    retry: { max_attempts: 3 },
  })),
}))

vi.mock('../../src/agent/router.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/agent/router.js')>()
  return {
    ...real,
    routeMessage: vi.fn(async () => ({
      push: vi.fn(async (ev: { source: string; type: 'message' | 'record'; content: string }) => ({
        id: 1, source: ev.source, type: ev.type, subtype: null, created_at: new Date().toISOString(), content: ev.content,
      })),
      pushBatch: vi.fn(async () => []),
      peek: vi.fn(async () => []),
    } as unknown as import('thread').ThreadStore)),
  }
})

vi.mock('../../src/agent/context.js', () => ({
  buildContext: vi.fn(async () => ({ system: '', history: [], userMessage: 'hello' })),
}))

vi.mock('../../src/agent/turn.js', () => ({
  processTurn: vi.fn(async () => ({ newMessages: [] })),
}))

vi.mock('../../src/agent/thread-lib.js', () => ({
  openOrCreateThread: vi.fn(async () => ({
    push: vi.fn(async (ev: { source: string; type: 'message' | 'record'; content: string }) => ({
      id: 1, source: ev.source, type: ev.type, subtype: null, created_at: new Date().toISOString(), content: ev.content,
    })),
    pushBatch: vi.fn(async () => []),
    peek: vi.fn(async () => []),
  })),
}))

vi.mock('../../src/config.js', () => ({
  getDaemonConfig: vi.fn(() => ({ theClawHome: '/tmp/test-home', ipcPort: 28213, logLevel: 'info' })),
}))

import { RunLoopImpl } from '../../src/agent/run-loop.js'
import { AsyncQueueImpl } from '../../src/agent/queue.js'
import { TaskManager } from '../../src/agent/tasks/task-manager.js'
import { getDaemonConfig } from '../../src/config.js'
import { loadAgentConfig } from '../../src/agent/config.js'
import { processTurn } from '../../src/agent/turn.js'
import { routeMessage } from '../../src/agent/router.js'

function makeConn(): IpcConnection {
  return { id: 'conn1', send: vi.fn(async () => {}), close: vi.fn(), isOpen: vi.fn(() => true) }
}

function makePai() {
  return { getProviderInfo: vi.fn(async () => ({ contextWindow: 100000, maxTokens: 4096 })) } as any
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), close: async () => {} }
}

class TestableRunLoop extends RunLoopImpl {
  exposeBuildTarget(source: string) {
    // @ts-expect-error accessing private method for testing
    return this.buildTarget(source)
  }
}

describe('RunLoopImpl', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('stop() closes the queue and resolves start()', async () => {
    const queue = new AsyncQueueImpl<never>()
    const loop = new RunLoopImpl('agent1', queue, new Map([['c1', makeConn()]]), makePai())
    const startPromise = loop.start()
    await loop.stop()
    await expect(startPromise).resolves.toBeUndefined()
  })

  it('start() resolves immediately when queue is already closed', async () => {
    const queue = new AsyncQueueImpl<never>()
    queue.close()
    await expect(new RunLoopImpl('agent1', queue, new Map([['c1', makeConn()]]), makePai()).start()).resolves.toBeUndefined()
  })

  it('stop() is idempotent', async () => {
    const queue = new AsyncQueueImpl<never>()
    const loop = new RunLoopImpl('agent1', queue, new Map([['c1', makeConn()]]), makePai())
    const p = loop.start()
    await loop.stop()
    await expect(loop.stop()).resolves.toBeUndefined()
    await p
  })

  describe('buildTarget()', () => {
    it('returns null for internal source', () => {
      const loop = new TestableRunLoop('agent1', new AsyncQueueImpl<never>(), new Map(), makePai())
      expect(loop.exposeBuildTarget('internal:agent:conv-abc:evolver')).toBeNull()
    })

    it('returns null for self source', () => {
      const loop = new TestableRunLoop('agent1', new AsyncQueueImpl<never>(), new Map(), makePai())
      expect(loop.exposeBuildTarget('self')).toBeNull()
    })

    it('returns OutboundTarget for valid external source', () => {
      const loop = new TestableRunLoop('agent1', new AsyncQueueImpl<never>(), new Map(), makePai())
      expect(loop.exposeBuildTarget('external:cli:default:dm:user1:user1')).toEqual({
        channel_id: 'cli:default', conversation_id: 'user1', peer_id: 'user1',
      })
    })
  })

  describe('no-connection warning suppression for internal source', () => {
    it('does NOT warn when processing internal source with no IPC connection', async () => {
      const logger = makeLogger()
      const queue = new AsyncQueueImpl<{ source: string; content: string }>()
      const loop = new RunLoopImpl('agent1', queue, new Map(), makePai(), logger)
      queue.push({ source: 'internal:agent:conv-abc:evolver', content: 'hello from agent' })
      queue.close()
      await loop.start()
      expect(logger.warn.mock.calls.map((c) => String(c[0])).some((m) => m.includes('No IPC connection available'))).toBe(false)
    })

    it('DOES warn when processing external source with no IPC connection', async () => {
      const logger = makeLogger()
      const queue = new AsyncQueueImpl<{ source: string; content: string }>()
      const loop = new RunLoopImpl('agent1', queue, new Map(), makePai(), logger)
      queue.push({ source: 'external:cli:default:dm:user1:user1', content: 'hello' })
      queue.close()
      await loop.start()
      expect(logger.warn.mock.calls.map((c) => String(c[0])).some((m) => m.includes('No IPC connection available'))).toBe(true)
    })
  })

  describe('extraEnv injection into processTurn', () => {
    it('passes XAR_AGENT_ID and XAR_CONV_ID derived from source to processTurn', async () => {
      vi.mocked(processTurn).mockClear()
      const { extractConvId } = await import('../../src/agent/router.js')
      const queue = new AsyncQueueImpl<{ source: string; content: string }>()
      const loop = new RunLoopImpl('my-agent', queue, new Map(), makePai())
      const source = 'external:tui:main:dm:conv-42:peer-1'
      queue.push({ source, content: 'hello' })
      queue.close()
      await loop.start()
      expect(vi.mocked(processTurn)).toHaveBeenCalledOnce()
      expect(vi.mocked(processTurn).mock.calls[0][0].extraEnv).toEqual({
        XAR_AGENT_ID: 'my-agent', XAR_CONV_ID: extractConvId(source),
      })
    })

    it('XAR_CONV_ID is conv-abc for internal source', async () => {
      vi.mocked(processTurn).mockClear()
      const queue = new AsyncQueueImpl<{ source: string; content: string }>()
      const loop = new RunLoopImpl('agent-x', queue, new Map(), makePai())
      const source = 'internal:agent:conv-abc:sender-agent'
      queue.push({ source, content: 'ping' })
      queue.close()
      await loop.start()
      expect(vi.mocked(processTurn)).toHaveBeenCalledOnce()
      expect(vi.mocked(processTurn).mock.calls[0][0].extraEnv).toMatchObject({
        XAR_AGENT_ID: 'agent-x', XAR_CONV_ID: 'conv-abc',
      })
    })
  })
})

// Requirements: 10.1, 10.2, 10.3, 10.4
describe('RunLoopImpl — worker announce & task state machine', () => {
  const AGENT_ID = 'orchestrator'
  let tmpDir: string
  let taskManager: TaskManager

  beforeEach(async () => {
    vi.clearAllMocks()
    tmpDir = await mkdtemp(join(tmpdir(), 'run-loop-test-'))
    vi.mocked(getDaemonConfig).mockReturnValue({ theClawHome: tmpDir, ipcPort: 28213, logLevel: 'info' })
    vi.mocked(loadAgentConfig).mockResolvedValue({
      agent_id: AGENT_ID, kind: 'user',
      pai: { provider: 'anthropic', model: 'claude-3' },
      routing: { mode: 'reactive', trigger: 'mention' },
      memory: { compact_threshold_tokens: 1000, session_compact_threshold_tokens: 500 },
      retry: { max_attempts: 3 },
    })
    taskManager = new TaskManager(AGENT_ID, tmpDir)
  })

  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }) })

  it('worker announce updates subtask status to done', async () => {
    const task = await taskManager.createTask({
      owner: AGENT_ID, originThreadId: 'peers/human', originEventId: 1,
      replyTarget: 'peer:human', waitAll: true,
      subtasks: [{ worker: 'worker-agent', instruction: 'do the thing' }],
    })
    const convId = task.task_id
    const queue = new AsyncQueueImpl<{ source: string; content: string }>()
    const loop = new RunLoopImpl(AGENT_ID, queue, new Map(), makePai(), makeLogger())
    queue.push({ source: `internal:task:${convId}:worker-agent`, content: 'Task completed successfully' })
    queue.close()
    await loop.start()
    const updated = await taskManager.getTask(task.task_id)
    expect(updated!.subtasks[0].status).toBe('done')
    expect(updated!.subtasks[0].result).toBe('Task completed successfully')
  })

  it('worker announce completing all subtasks triggers a summary Turn', async () => {
    vi.mocked(processTurn).mockClear()
    const task = await taskManager.createTask({
      owner: AGENT_ID, originThreadId: 'peers/human', originEventId: 1,
      replyTarget: 'peer:human', waitAll: true,
      subtasks: [{ worker: 'worker-agent', instruction: 'analyze data' }],
    })
    const convId = task.task_id
    const queue = new AsyncQueueImpl<{ source: string; content: string }>()
    const loop = new RunLoopImpl(AGENT_ID, queue, new Map(), makePai(), makeLogger())
    queue.push({ source: `internal:task:${convId}:worker-agent`, content: 'Analysis complete' })
    queue.close()
    await loop.start()
    expect(vi.mocked(processTurn)).toHaveBeenCalledOnce()
  })

  it('announce for a cancelled task is discarded — no processTurn call', async () => {
    vi.mocked(processTurn).mockClear()
    const task = await taskManager.createTask({
      owner: AGENT_ID, originThreadId: 'peers/human', originEventId: 1,
      replyTarget: 'peer:human', waitAll: true,
      subtasks: [{ worker: 'worker-agent', instruction: 'do work' }],
    })
    await taskManager.cancelTask(task.task_id)
    const convId = task.task_id
    const queue = new AsyncQueueImpl<{ source: string; content: string }>()
    const loop = new RunLoopImpl(AGENT_ID, queue, new Map(), makePai(), makeLogger())
    queue.push({ source: `internal:task:${convId}:worker-agent`, content: 'Work done' })
    queue.close()
    await loop.start()
    expect(vi.mocked(processTurn)).not.toHaveBeenCalled()
  })

  it('announce for a cancelled task does not change task status', async () => {
    const task = await taskManager.createTask({
      owner: AGENT_ID, originThreadId: 'peers/human', originEventId: 1,
      replyTarget: 'peer:human', waitAll: true,
      subtasks: [{ worker: 'worker-agent', instruction: 'do work' }],
    })
    await taskManager.cancelTask(task.task_id)
    const convId = task.task_id
    const queue = new AsyncQueueImpl<{ source: string; content: string }>()
    const loop = new RunLoopImpl(AGENT_ID, queue, new Map(), makePai(), makeLogger())
    queue.push({ source: `internal:task:${convId}:worker-agent`, content: 'Work done' })
    queue.close()
    await loop.start()
    expect((await taskManager.getTask(task.task_id))!.status).toBe('cancelled')
  })

  it('worker announce with [Task failed] prefix marks subtask as failed', async () => {
    const task = await taskManager.createTask({
      owner: AGENT_ID, originThreadId: 'peers/human', originEventId: 1,
      replyTarget: 'peer:human', waitAll: true,
      subtasks: [{ worker: 'worker-agent', instruction: 'risky work' }],
    })
    const convId = task.task_id
    const queue = new AsyncQueueImpl<{ source: string; content: string }>()
    const loop = new RunLoopImpl(AGENT_ID, queue, new Map(), makePai(), makeLogger())
    queue.push({ source: `internal:task:${convId}:worker-agent`, content: '[Task failed] Something went wrong' })
    queue.close()
    await loop.start()
    expect((await taskManager.getTask(task.task_id))!.subtasks[0].status).toBe('failed')
  })
})

// Requirement 3.3: reactive + mention trigger + group + mentioned=false -> record, no LLM
describe('RunLoopImpl — determineEventType record path', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getDaemonConfig).mockReturnValue({ theClawHome: '/tmp/test-home', ipcPort: 28213, logLevel: 'info' })
  })

  it('group message with mentioned=false is stored as record — no processTurn call', async () => {
    vi.mocked(processTurn).mockClear()
    vi.mocked(loadAgentConfig).mockResolvedValue({
      agent_id: 'agent1', kind: 'user',
      pai: { provider: 'anthropic', model: 'claude-3' },
      routing: { mode: 'reactive', trigger: 'mention' },
      memory: { compact_threshold_tokens: 1000, session_compact_threshold_tokens: 500 },
      retry: { max_attempts: 3 },
    })
    const pushCalls: Array<{ type: string }> = []
    vi.mocked(routeMessage).mockResolvedValue({
      push: vi.fn(async (ev: { source: string; type: 'message' | 'record'; content: string }) => {
        pushCalls.push({ type: ev.type })
        return { id: 1, source: ev.source, type: ev.type, subtype: null, created_at: '', content: ev.content }
      }),
      pushBatch: vi.fn(async () => []),
      peek: vi.fn(async () => []),
    } as unknown as import('thread').ThreadStore)
    const queue = new AsyncQueueImpl<{ source: string; content: string; conversation_type?: string; mentioned?: boolean }>()
    const loop = new RunLoopImpl('agent1', queue, new Map(), makePai(), makeLogger())
    queue.push({ source: 'external:tg:main:group:conv-group1:user1', content: 'just chatting', conversation_type: 'group', mentioned: false })
    queue.close()
    await loop.start()
    expect(vi.mocked(processTurn)).not.toHaveBeenCalled()
    expect(pushCalls.some((e) => e.type === 'record')).toBe(true)
  })

  it('group message with mentioned=true triggers processTurn', async () => {
    vi.mocked(processTurn).mockClear()
    vi.mocked(loadAgentConfig).mockResolvedValue({
      agent_id: 'agent1', kind: 'user',
      pai: { provider: 'anthropic', model: 'claude-3' },
      routing: { mode: 'reactive', trigger: 'mention' },
      memory: { compact_threshold_tokens: 1000, session_compact_threshold_tokens: 500 },
      retry: { max_attempts: 3 },
    })
    const queue = new AsyncQueueImpl<{ source: string; content: string; conversation_type?: string; mentioned?: boolean }>()
    const loop = new RunLoopImpl('agent1', queue, new Map(), makePai(), makeLogger())
    queue.push({ source: 'external:tg:main:group:conv-group1:user1', content: '@agent1 help', conversation_type: 'group', mentioned: true })
    queue.close()
    await loop.start()
    expect(vi.mocked(processTurn)).toHaveBeenCalledOnce()
  })

  it('autonomous mode always triggers processTurn regardless of mentioned', async () => {
    vi.mocked(processTurn).mockClear()
    vi.mocked(loadAgentConfig).mockResolvedValue({
      agent_id: 'agent1', kind: 'user',
      pai: { provider: 'anthropic', model: 'claude-3' },
      routing: { mode: 'autonomous', trigger: 'all' },
      memory: { compact_threshold_tokens: 1000, session_compact_threshold_tokens: 500 },
      retry: { max_attempts: 3 },
    })
    const queue = new AsyncQueueImpl<{ source: string; content: string; conversation_type?: string; mentioned?: boolean }>()
    const loop = new RunLoopImpl('agent1', queue, new Map(), makePai(), makeLogger())
    queue.push({ source: 'external:tg:main:group:conv-group1:user1', content: 'just chatting', conversation_type: 'group', mentioned: false })
    queue.close()
    await loop.start()
    expect(vi.mocked(processTurn)).toHaveBeenCalledOnce()
  })
})
