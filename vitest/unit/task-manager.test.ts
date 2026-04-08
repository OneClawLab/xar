/**
 * Unit tests for TaskManager — boundary cases
 * Requirements: 1.1, 2.1, 2.3
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { TaskManager } from '../../src/agent/tasks/task-manager.js'
import type { CreateTaskParams } from '../../src/agent/tasks/task-types.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

const AGENT_ID = 'test-agent'

function baseParams(overrides: Partial<CreateTaskParams> = {}): CreateTaskParams {
  return {
    owner: AGENT_ID,
    originThreadId: 'thread-1',
    originEventId: 1,
    replyTarget: 'peer:human',
    waitAll: true,
    subtasks: [],
    ...overrides,
  }
}

let tmpDir: string
let manager: TaskManager

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'task-manager-unit-'))
  manager = new TaskManager(AGENT_ID, tmpDir)
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

// ── createTask ────────────────────────────────────────────────────────────────

describe('createTask', () => {
  it('empty subtasks list → task created with 0 subtasks', async () => {
    const task = await manager.createTask(baseParams({ subtasks: [] }))

    expect(task.subtasks).toHaveLength(0)
    expect(task.task_id).toBeTruthy()
    expect(task.status).toBe('waiting') // waitAll=true, but no subtasks → still 'waiting'
  })

  it('single subtask → task created with 1 subtask, status=sent', async () => {
    const task = await manager.createTask(
      baseParams({ subtasks: [{ worker: 'worker-1', instruction: 'do something' }] }),
    )

    expect(task.subtasks).toHaveLength(1)
    expect(task.subtasks[0]!.status).toBe('sent')
    expect(task.subtasks[0]!.worker).toBe('worker-1')
    expect(task.subtasks[0]!.instruction).toBe('do something')
  })

  it('waitAll=false → task status is pending', async () => {
    const task = await manager.createTask(
      baseParams({ waitAll: false, subtasks: [{ worker: 'w1', instruction: 'go' }] }),
    )

    expect(task.status).toBe('pending')
  })

  it('subtask ids are generated sequentially (st-1, st-2, ...)', async () => {
    const task = await manager.createTask(
      baseParams({
        subtasks: [
          { worker: 'w1', instruction: 'a' },
          { worker: 'w2', instruction: 'b' },
          { worker: 'w3', instruction: 'c' },
        ],
      }),
    )

    expect(task.subtasks[0]!.subtask_id).toBe('st-1')
    expect(task.subtasks[1]!.subtask_id).toBe('st-2')
    expect(task.subtasks[2]!.subtask_id).toBe('st-3')
  })
})

// ── handleAnnounce ────────────────────────────────────────────────────────────

describe('handleAnnounce', () => {
  it('non-existent task → returns { taskCompleted: false }', async () => {
    const result = await manager.handleAnnounce('no-such-task', 'worker-1', 'result', false)

    expect(result.taskCompleted).toBe(false)
  })

  it('duplicate announce (same worker twice) → second announce is a no-op', async () => {
    const task = await manager.createTask(
      baseParams({ subtasks: [{ worker: 'worker-1', instruction: 'go' }] }),
    )

    // First announce — marks subtask as done
    const first = await manager.handleAnnounce(task.task_id, 'worker-1', 'result-1', false)
    expect(first.task.subtasks[0]!.status).toBe('done')
    expect(first.task.subtasks[0]!.result).toBe('result-1')

    // Second announce — subtask already terminal, no match found, result unchanged
    const second = await manager.handleAnnounce(task.task_id, 'worker-1', 'result-2', false)
    expect(second.task.subtasks[0]!.status).toBe('done')
    expect(second.task.subtasks[0]!.result).toBe('result-1') // original result preserved
  })

  it('all subtasks announced → taskCompleted=true when waitAll=true', async () => {
    const task = await manager.createTask(
      baseParams({
        waitAll: true,
        subtasks: [
          { worker: 'w1', instruction: 'a' },
          { worker: 'w2', instruction: 'b' },
        ],
      }),
    )

    await manager.handleAnnounce(task.task_id, 'w1', 'r1', false)
    const result = await manager.handleAnnounce(task.task_id, 'w2', 'r2', false)

    expect(result.taskCompleted).toBe(true)
    expect(result.task.status).toBe('done')
  })

  it('cancelled task announce → taskCompleted=false, status stays cancelled', async () => {
    const task = await manager.createTask(
      baseParams({ subtasks: [{ worker: 'w1', instruction: 'go' }] }),
    )
    await manager.cancelTask(task.task_id)

    const result = await manager.handleAnnounce(task.task_id, 'w1', 'result', false)

    expect(result.taskCompleted).toBe(false)
    expect(result.task.status).toBe('cancelled')
  })
})

// ── cancelTask ────────────────────────────────────────────────────────────────

describe('cancelTask', () => {
  it('non-existent task → returns { cancelled: false }', async () => {
    const result = await manager.cancelTask('no-such-task')

    expect(result.cancelled).toBe(false)
  })

  it('existing task → returns { cancelled: true } and persists status=cancelled', async () => {
    const task = await manager.createTask(
      baseParams({ subtasks: [{ worker: 'w1', instruction: 'go' }] }),
    )

    const result = await manager.cancelTask(task.task_id)
    expect(result.cancelled).toBe(true)

    const persisted = await manager.getTask(task.task_id)
    expect(persisted!.status).toBe('cancelled')
  })

  it('already-completed task → returns { cancelled: true } and overwrites status to cancelled', async () => {
    const task = await manager.createTask(
      baseParams({ subtasks: [{ worker: 'w1', instruction: 'go' }] }),
    )
    // Complete the task first
    await manager.handleAnnounce(task.task_id, 'w1', 'done', false)
    const completed = await manager.getTask(task.task_id)
    expect(completed!.status).toBe('done')

    // Cancel after completion — file exists so cancelled=true, status is overwritten
    const result = await manager.cancelTask(task.task_id)
    expect(result.cancelled).toBe(true)
    const persisted = await manager.getTask(task.task_id)
    expect(persisted!.status).toBe('cancelled')
  })
})

// ── getTask ───────────────────────────────────────────────────────────────────

describe('getTask', () => {
  it('non-existent task → returns null', async () => {
    const result = await manager.getTask('no-such-task')

    expect(result).toBeNull()
  })

  it('existing task → returns the task', async () => {
    const task = await manager.createTask(baseParams())

    const result = await manager.getTask(task.task_id)

    expect(result).not.toBeNull()
    expect(result!.task_id).toBe(task.task_id)
  })
})

// ── isTaskCancelled ───────────────────────────────────────────────────────────

describe('isTaskCancelled', () => {
  it('non-existent task → returns false', async () => {
    const result = await manager.isTaskCancelled('no-such-task')

    expect(result).toBe(false)
  })

  it('active task → returns false', async () => {
    const task = await manager.createTask(baseParams())

    expect(await manager.isTaskCancelled(task.task_id)).toBe(false)
  })

  it('cancelled task → returns true', async () => {
    const task = await manager.createTask(baseParams())
    await manager.cancelTask(task.task_id)

    expect(await manager.isTaskCancelled(task.task_id)).toBe(true)
  })
})

// ── getPendingTasks ───────────────────────────────────────────────────────────

describe('getPendingTasks', () => {
  it('no tasks → returns []', async () => {
    const result = await manager.getPendingTasks()

    expect(result).toEqual([])
  })

  it('returns only waiting tasks (not done/cancelled/pending)', async () => {
    // waiting task (waitAll=true, subtasks not yet announced)
    const waiting = await manager.createTask(
      baseParams({ waitAll: true, subtasks: [{ worker: 'w1', instruction: 'go' }] }),
    )

    // pending task (waitAll=false)
    await manager.createTask(
      baseParams({ waitAll: false, subtasks: [{ worker: 'w2', instruction: 'go' }] }),
    )

    // cancelled task
    const toCancel = await manager.createTask(
      baseParams({ waitAll: true, subtasks: [{ worker: 'w3', instruction: 'go' }] }),
    )
    await manager.cancelTask(toCancel.task_id)

    // done task
    const toDone = await manager.createTask(
      baseParams({ waitAll: true, subtasks: [{ worker: 'w4', instruction: 'go' }] }),
    )
    await manager.handleAnnounce(toDone.task_id, 'w4', 'result', false)

    const result = await manager.getPendingTasks()

    expect(result).toHaveLength(1)
    expect(result[0]!.task_id).toBe(waiting.task_id)
  })
})
