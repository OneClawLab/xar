/**
 * Unit tests for cancel_task tool
 * Requirements: 1.4, 2.1, 2.2
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { TaskManager } from '../../src/agent/task-manager.js'
import { createCancelTaskTool } from '../../src/agent/cancel-task.js'
import type { InboundMessage } from '../../src/types.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

const AGENT_ID = 'orchestrator'

function makeDeps(
  taskManager: TaskManager,
  sendToAgent: (agentId: string, msg: InboundMessage) => Promise<void>,
) {
  return { taskManager, agentId: AGENT_ID, sendToAgent }
}

/** Create a task with the given workers and return its task_id */
async function createTask(
  manager: TaskManager,
  workers: string[],
  waitAll = true,
): Promise<string> {
  const task = await manager.createTask({
    owner: AGENT_ID,
    originThreadId: 'peers/alice',
    originEventId: 1,
    replyTarget: 'peer:alice',
    waitAll,
    subtasks: workers.map((w) => ({ worker: w, instruction: 'do work' })),
  })
  return task.task_id
}

let tmpDir: string
let manager: TaskManager

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'cancel-task-unit-'))
  manager = new TaskManager(AGENT_ID, tmpDir)
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

// ── Normal case ───────────────────────────────────────────────────────────────

describe('cancel_task handler — normal case', () => {
  it('cancels task and returns { cancelled: true }', async () => {
    const taskId = await createTask(manager, ['worker-1'])
    const tool = createCancelTaskTool(makeDeps(manager, async () => {}))

    const result = await tool.handler({ task_id: taskId })

    expect(result).toEqual({ cancelled: true })
  })

  it('sends cancellation to each sent subtask worker', async () => {
    const taskId = await createTask(manager, ['worker-1', 'worker-2'])
    const sent: Array<{ agentId: string; msg: InboundMessage }> = []
    const tool = createCancelTaskTool(
      makeDeps(manager, async (agentId, msg) => {
        sent.push({ agentId, msg })
      }),
    )

    await tool.handler({ task_id: taskId })

    expect(sent).toHaveLength(2)
    expect(sent.map((s) => s.agentId).sort()).toEqual(['worker-1', 'worker-2'])
  })

  it('cancellation messages have NO reply_to field', async () => {
    const taskId = await createTask(manager, ['worker-1'])
    const sent: Array<{ agentId: string; msg: InboundMessage }> = []
    const tool = createCancelTaskTool(
      makeDeps(manager, async (agentId, msg) => {
        sent.push({ agentId, msg })
      }),
    )

    await tool.handler({ task_id: taskId })

    expect(sent[0]!.msg.reply_to).toBeUndefined()
  })
})

// ── Task doesn't exist ────────────────────────────────────────────────────────

describe('cancel_task handler — task not found', () => {
  it('returns { cancelled: false } when task_id does not exist', async () => {
    const tool = createCancelTaskTool(makeDeps(manager, async () => {}))

    const result = await tool.handler({ task_id: 'no-such-task' })

    expect(result).toEqual({ cancelled: false })
  })

  it('does not call sendToAgent when task does not exist', async () => {
    let called = false
    const tool = createCancelTaskTool(
      makeDeps(manager, async () => {
        called = true
      }),
    )

    await tool.handler({ task_id: 'no-such-task' })

    expect(called).toBe(false)
  })
})

// ── Only sends to status=sent subtasks ───────────────────────────────────────

describe('cancel_task handler — only cancels sent subtasks', () => {
  it('does not send cancellation to done subtasks', async () => {
    const taskId = await createTask(manager, ['worker-1', 'worker-2'])

    // Mark worker-1 as done via handleAnnounce
    await manager.handleAnnounce(taskId, 'worker-1', 'result', false)

    const sent: Array<{ agentId: string; msg: InboundMessage }> = []
    const tool = createCancelTaskTool(
      makeDeps(manager, async (agentId, msg) => {
        sent.push({ agentId, msg })
      }),
    )

    await tool.handler({ task_id: taskId })

    // Only worker-2 (still sent) should receive cancellation
    expect(sent).toHaveLength(1)
    expect(sent[0]!.agentId).toBe('worker-2')
  })

  it('no sent subtasks → no cancellation messages sent', async () => {
    // Create a task with no subtasks
    const task = await manager.createTask({
      owner: AGENT_ID,
      originThreadId: 'peers/alice',
      originEventId: 1,
      replyTarget: 'peer:alice',
      waitAll: true,
      subtasks: [],
    })

    const sent: Array<{ agentId: string; msg: InboundMessage }> = []
    const tool = createCancelTaskTool(
      makeDeps(manager, async (agentId, msg) => {
        sent.push({ agentId, msg })
      }),
    )

    await tool.handler({ task_id: task.task_id })

    expect(sent).toHaveLength(0)
  })
})
