/**
 * Task Manager: manages Task/SubTask lifecycle for fan-out/fan-in coordination.
 * Tasks are persisted as JSON files at <theClawHome>/agents/<agentId>/tasks/<task_id>.json
 */

import { promises as fs } from 'fs'
import { join } from 'path'
import type { Task, SubTask, CreateTaskParams, AnnounceResult, TaskManager as ITaskManager } from './task-types.js'

function generateTaskId(agentId: string): string {
  const timestamp = Date.now()
  const random = Math.random().toString(36).slice(2, 8)
  return `${agentId}-${timestamp}-${random}`
}

function generateSubtaskId(index: number): string {
  return `st-${index + 1}`
}

function now(): string {
  return new Date().toISOString()
}

export class TaskManager implements ITaskManager {
  private readonly agentId: string
  private readonly tasksDir: string

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
  ): Promise<AnnounceResult> {
    const task = await this.getTask(taskId)
    if (!task) {
      // Task not found — return a minimal safe response
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

    // If task is cancelled, discard the announce
    if (task.status === 'cancelled') {
      return { taskCompleted: false, task }
    }

    // Find the matching subtask by worker agent id (first sent/pending match)
    const subtask = task.subtasks.find(
      (st) => st.worker === workerAgentId && (st.status === 'sent' || st.status === 'pending'),
    )

    if (subtask) {
      subtask.status = failed ? 'failed' : 'done'
      subtask.result = result
    }

    task.updated_at = now()

    // Check fan-in: all subtasks must be in terminal state (done or failed)
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
}
