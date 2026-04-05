/**
 * create_task tool — allows the orchestrator agent to fan-out work to worker agents.
 *
 * Creates a Task via TaskManager, then sends delegation messages to each worker.
 * Requirements: 1.1, 1.2, 1.3, 1.4, 2.5
 */

import type { Tool } from 'pai'
import type { TaskManager } from './task-types.js'
import { stripAgentPrefix } from './task-types.js'
import type { InboundMessage } from '../types.js'

// ── Factory ──────────────────────────────────────────────────────────────────

export interface CreateTaskToolDeps {
  taskManager: TaskManager
  agentId: string
  originThreadId: string
  originEventId: number
  replyTarget: string
  sendToAgent: (agentId: string, message: InboundMessage) => Promise<void>
}

const CREATE_TASK_TOOL_DESC = `
Create a task with one or more subtasks delegated to worker agents.
Use this when you need to:
- Fan out work to multiple agents and wait for all results
- Delegate a task to a single agent and wait for the result
Set wait_all=true to receive a summary turn when all subtasks complete.
Set wait_all=false for fire-and-forget delegation.
`.trim();

export function createCreateTaskTool(deps: CreateTaskToolDeps): Tool {
  const { taskManager, agentId, originThreadId, originEventId, replyTarget, sendToAgent } = deps

  return {
    name: 'create_task',
    description: CREATE_TASK_TOOL_DESC,
    parameters: {
      type: 'object',
      properties: {
        subtasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              worker: {
                type: 'string',
                description: '"agent:<agent_id>" — the worker agent to delegate to',
              },
              instruction: {
                type: 'string',
                description: 'Task description delegated to the worker',
              },
            },
            required: ['worker', 'instruction'],
          },
          description: 'List of subtasks to delegate to worker agents',
        },
        wait_all: {
          type: 'boolean',
          description:
            'true: wait for all subtasks to complete and receive a summary turn; false: fire-and-forget',
        },
      },
      required: ['subtasks', 'wait_all'],
    },

    async handler(args: unknown): Promise<unknown> {
      const { subtasks, wait_all } = args as {
        subtasks: Array<{ worker: string; instruction: string }>
        wait_all: boolean
      }

      // Normalise worker addresses: strip "agent:" prefix for TaskManager
      const normalisedSubtasks = subtasks.map((st) => ({
        worker: stripAgentPrefix(st.worker),
        instruction: st.instruction,
      }))

      // 1. Create the Task via TaskManager
      const task = await taskManager.createTask({
        owner: agentId,
        originThreadId,
        originEventId,
        replyTarget,
        waitAll: wait_all,
        subtasks: normalisedSubtasks,
      })

      // 2. Send delegation messages to each worker
      //    convId == task_id so handleWorkerAnnounce can look up the task directly.
      //    Source format: internal:task:<task_id>:<agentId>
      const convId = task.task_id
      const source = `internal:task:${convId}:${agentId}`

      for (const subtask of task.subtasks) {
        const workerAgentId = stripAgentPrefix(subtask.worker)

        const delegationMessage: InboundMessage = {
          source,
          content: subtask.instruction,
          reply_to: `agent:${agentId}`,
        }

        await sendToAgent(workerAgentId, delegationMessage)
      }

      return {
        task_id: task.task_id,
        status: task.status,
      }
    },
  }
}
