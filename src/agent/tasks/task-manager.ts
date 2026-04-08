/**
 * Task Manager: manages Task/SubTask lifecycle for fan-out/fan-in coordination.
 * Tasks are persisted as JSON files at <theClawHome>/agents/<agentId>/tasks/<task_id>.json
 */

import { promises as fs } from 'fs'
import { join } from 'path'
import type { Task, SubTask, CreateTaskParams, AnnounceResult, SteerTaskParams, SteerTaskResult, TaskManager as ITaskManager } from './task-types.js'

function generateTaskId(agentId: string): string {
  const timestamp = Date.now()
  const random = Math.random().toString(36).slice(2, 8)
  return `${agentId}-${timestamp}-${random}`
}

function generateSubtaskId(index: number): string {
  return `st-${index + 1}`
}

function generateDelegationId(): string {
  return `dlg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function now(): string {
  return new Date().toISOString()
}

export class TaskManager implements ITaskManager {
  private readonly agentId: string
  private readonly tasksDir: string
  /** Per-task announce mutex: serialises concurrent handleAnnounce calls for the same task. */
  private readonly announceLocks = new Map<string, Promise<AnnounceResult>>()

  constructor(agentId: string, theClawHome: string) {
    this.agentId = agentId
    this.tasksDir = join(theClawHome, 'agents', agentId, 'tasks')
  }

  private taskPath(taskId: string): string {
    return join(this.tasksDir, `${taskId}.json`)
  }

  private async ensureTasksDir(): Promise<void> {
    await fs.mkdir(this.tasksDir, { recursive: true })
  }

  private async writeTask(task: Task): Promise<void> {
    await this.ensureTasksDir()
    await fs.writeFile(this.taskPath(task.task_id), JSON.stringify(task, null, 2), 'utf-8')
  }

  async createTask(params: CreateTaskParams): Promise<Task> {
    const taskId = generateTaskId(this.agentId)
    const ts = now()

    const subtasks: SubTask[] = params.subtasks.map((s, i) => ({
      subtask_id: generateSubtaskId(i),
      delegation_id: generateDelegationId(),
      worker: s.worker,
      instruction: s.instruction,
      status: 'sent' as const,
    }))

    const task: Task = {
      task_id: taskId,
      owner: params.owner,
      origin: {
        thread_id: params.originThreadId,
        event_id: params.originEventId,
        reply_target: params.replyTarget,
      },
      status: params.waitAll ? 'waiting' : 'pending',
      wait_all: params.waitAll,
      subtasks,
      created_at: ts,
      updated_at: ts,
    }

    await this.writeTask(task)
    return task
  }

  async cancelTask(taskId: string): Promise<{ cancelled: boolean }> {
    const task = await this.getTask(taskId)
    if (!task) {
      return { cancelled: false }
    }

    task.status = 'cancelled'
    task.updated_at = now()
    await this.writeTask(task)
    return { cancelled: true }
  }

  async handleAnnounce(
    taskId: string,
    workerAgentId: string,
    result: string,
    failed: boolean,
    delegationId?: string,
  ): Promise<AnnounceResult> {
    // Serialise concurrent announces for the same task via a promise chain (Fix 3).
    const prev = this.announceLocks.get(taskId) ?? Promise.resolve({} as AnnounceResult)
    const next = prev.then(() => this._handleAnnounceInner(taskId, workerAgentId, result, failed, delegationId))
    // Keep the chain alive only while there are pending announces; clean up on settle.
    this.announceLocks.set(taskId, next.catch(() => ({} as AnnounceResult)))
    const announceResult = await next
    // If the task is now terminal, remove the lock entry to avoid memory leak.
    if (announceResult.task.status === 'done' || announceResult.task.status === 'failed' || announceResult.task.status === 'cancelled') {
      this.announceLocks.delete(taskId)
    }
    return announceResult
  }

  private async _handleAnnounceInner(
    taskId: string,
    workerAgentId: string,
    result: string,
    failed: boolean,
    delegationId?: string,
  ): Promise<AnnounceResult> {
    const task = await this.getTask(taskId)
    if (!task) {
      const placeholder: Task = {
        task_id: taskId,
        owner: '',
        origin: { thread_id: '', event_id: 0, reply_target: '' },
        status: 'failed',
        wait_all: false,
        subtasks: [],
        created_at: now(),
        updated_at: now(),
      }
      return { taskCompleted: false, task: placeholder }
    }

    if (task.status === 'cancelled') {
      return { taskCompleted: false, task }
    }

    // Fix 2: prefer delegation_id match for idempotency; fall back to worker+status match.
    let subtask: SubTask | undefined
    if (delegationId) {
      subtask = task.subtasks.find((st) => st.delegation_id === delegationId && (st.status === 'sent' || st.status === 'pending'))
    }
    if (!subtask) {
      subtask = task.subtasks.find(
        (st) => st.worker === workerAgentId && (st.status === 'sent' || st.status === 'pending'),
      )
    }

    if (subtask) {
      subtask.status = failed ? 'failed' : 'done'
      subtask.result = result
    }

    task.updated_at = now()

    const allTerminal = task.subtasks.every((st) => st.status === 'done' || st.status === 'failed')

    if (allTerminal && task.wait_all) {
      task.status = 'done'
    }

    await this.writeTask(task)

    return {
      taskCompleted: allTerminal && task.wait_all,
      task,
    }
  }

  async getTask(taskId: string): Promise<Task | null> {
    try {
      const data = await fs.readFile(this.taskPath(taskId), 'utf-8')
      return JSON.parse(data) as Task
    } catch {
      return null
    }
  }

  async getPendingTasks(): Promise<Task[]> {
    try {
      await this.ensureTasksDir()
      const files = await fs.readdir(this.tasksDir)
      const tasks: Task[] = []

      for (const file of files) {
        if (!file.endsWith('.json')) continue
        try {
          const data = await fs.readFile(join(this.tasksDir, file), 'utf-8')
          const task = JSON.parse(data) as Task
          if (task.status === 'waiting') {
            tasks.push(task)
          }
        } catch {
          // Skip unreadable files
        }
      }

      return tasks
    } catch {
      return []
    }
  }

  async isTaskCancelled(taskId: string): Promise<boolean> {
    const task = await this.getTask(taskId)
    if (!task) return false
    return task.status === 'cancelled'
  }

  async steerTask(params: SteerTaskParams): Promise<SteerTaskResult> {
    const { taskId, worker, newInstruction } = params
    const task = await this.getTask(taskId)

    if (!task) {
      return { steered: false, delegation_id: '', message: `Task ${taskId} not found` }
    }
    if (task.status === 'cancelled' || task.status === 'done' || task.status === 'failed') {
      return { steered: false, delegation_id: '', message: `Task ${taskId} is already in terminal state: ${task.status}` }
    }

    // Find the target subtask — must be in 'sent' state (still in-flight)
    const subtask = task.subtasks.find((st) => st.worker === worker && st.status === 'sent')
    if (!subtask) {
      return { steered: false, delegation_id: '', message: `No in-flight subtask found for worker ${worker} in task ${taskId}` }
    }

    // Archive the current instruction into steer_history before overwriting
    const historyEntry = {
      instruction: subtask.instruction,
      delegation_id: subtask.delegation_id,
      steered_at: now(),
    }
    subtask.steer_history = [...(subtask.steer_history ?? []), historyEntry]

    // Issue a new delegation_id so the steer message is matched correctly on announce
    const newDelegationId = generateDelegationId()
    subtask.instruction = newInstruction
    subtask.delegation_id = newDelegationId
    // Keep status as 'sent' — the worker is still expected to reply

    task.updated_at = now()
    await this.writeTask(task)

    return { steered: true, delegation_id: newDelegationId }
  }

  /** Return tasks that are still 'waiting' and have subtasks stuck in 'sent' state.
   *  These are stale after a daemon restart and need re-delegation. */
  async getStaleTasks(): Promise<Task[]> {
    try {
      await this.ensureTasksDir()
      const files = await fs.readdir(this.tasksDir)
      const tasks: Task[] = []

      for (const file of files) {
        if (!file.endsWith('.json')) continue
        try {
          const data = await fs.readFile(join(this.tasksDir, file), 'utf-8')
          const task = JSON.parse(data) as Task
          if (task.status === 'waiting' && task.subtasks.some((st) => st.status === 'sent')) {
            tasks.push(task)
          }
        } catch {
          // Skip unreadable files
        }
      }

      return tasks
    } catch {
      return []
    }
  }
}
