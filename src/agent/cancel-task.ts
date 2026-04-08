/**
 * cancel_task tool — allows the orchestrator agent to cancel an in-progress task.
 *
 * Cancels the Task via TaskManager, then sends cancellation notifications to all
 * workers with status=sent. Cancellation messages are fire-and-forget (no reply_to).
 * Requirements: 2.1, 2.2
 */

import { defineTool } from 'pai'
import type { TaskManager } from './task-types.js'
import { stripAgentPrefix } from './task-types.js'
import type { InboundMessage } from '../types.js'

// ── Tool I/O types ────────────────────────────────────────────────────────────

export interface CancelTaskToolInput {
  task_id: string
}

export interface CancelTaskToolOutput {
  cancelled: boolean
}

// ── Factory ──────────────────────────────────────────────────────────────────

export interface CancelTaskToolDeps {
  taskManager: TaskManager
  agentId: string
  sendToAgent: (agentId: string, message: InboundMessage) => Promise<void>
}

export function createCancelTaskTool(deps: CancelTaskToolDeps) {
  const { taskManager, agentId, sendToAgent } = deps

  return defineTool<CancelTaskToolInput, CancelTaskToolOutput>({
    name: 'cancel_task',
    description: `Cancel a task and notify all active workers.
Workers will be notified asynchronously. Already-completed subtasks are not affected.`,
    parameters: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'The ID of the task to cancel',
        },
      },
      required: ['task_id'],
    },

    async handler({ task_id }) {
      // 1. Fetch the task before cancelling so we can identify sent subtasks
      const task = await taskManager.getTask(task_id)

      // 2. Cancel the task via TaskManager
      const result = await taskManager.cancelTask(task_id)

      if (!result.cancelled || !task) {
        return { cancelled: false }
      }

      // 3. Send cancellation notifications to all workers with status=sent
      //    convId == task_id (mirrors create-task convention)
      //    No reply_to — cancellation is fire-and-forget (Requirement 2.2)
      const convId = task_id
      const source = `internal:task:${convId}:${agentId}`

      const sentSubtasks = task.subtasks.filter((st) => st.status === 'sent')

      for (const subtask of sentSubtasks) {
        const workerAgentId = stripAgentPrefix(subtask.worker)

        const cancellationMessage: InboundMessage = {
          source,
          content: 'Task cancelled',
          // No reply_to — signals this is a cancellation notification, not a delegation
        }

        await sendToAgent(workerAgentId, cancellationMessage)
      }

      return { cancelled: true }
    },
  })
}
