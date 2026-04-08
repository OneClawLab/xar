/**
 * steer_task tool — allows the orchestrator to send a revised instruction to an
 * in-flight worker subtask.
 *
 * Flow:
 *   1. TaskManager.steerTask() archives the old instruction, issues a new delegation_id.
 *   2. A new delegation message (with reply_to) is sent to the worker's queue.
 *   3. The worker processes it as a normal Worker Turn and announces the result back.
 *   4. handleAnnounce matches by the new delegation_id, updating the subtask as usual.
 *
 * The worker may be mid-turn when the steer arrives; in that case the MidTurnInjector
 * will surface it as a receive_user_update, letting the worker incorporate the new
 * instruction without waiting for a full new turn.
 */

import { defineTool } from 'pai'
import type { TaskManager } from './task-types.js'
import { stripAgentPrefix } from './task-types.js'
import type { InboundMessage } from '../../types.js'

// ── Tool I/O types ────────────────────────────────────────────────────────────

export interface SteerTaskToolInput {
  task_id: string
  worker: string
  new_instruction: string
}

export interface SteerTaskToolOutput {
  steered: boolean
  message?: string
}

// ── Factory ──────────────────────────────────────────────────────────────────

export interface SteerTaskToolDeps {
  taskManager: TaskManager
  agentId: string
  sendToAgent: (agentId: string, message: InboundMessage) => Promise<void>
}

const STEER_TASK_TOOL_DESC = `
Send a revised instruction to an in-flight worker subtask.
Use this when you want to change or refine what a worker is doing before it finishes.
Only works on subtasks that are still in-flight (status=sent).
The worker will receive the new instruction as a new turn; its reply will be reported back as usual.
`.trim();

export function createSteerTaskTool(deps: SteerTaskToolDeps) {
  const { taskManager, agentId, sendToAgent } = deps

  return defineTool<SteerTaskToolInput, SteerTaskToolOutput>({
    name: 'steer_task',
    description: STEER_TASK_TOOL_DESC,
    parameters: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'The ID of the task containing the subtask to steer',
        },
        worker: {
          type: 'string',
          description: '"agent:<agent_id>" — the worker whose subtask should be steered',
        },
        new_instruction: {
          type: 'string',
          description: 'The revised instruction to send to the worker',
        },
      },
      required: ['task_id', 'worker', 'new_instruction'],
    },

    async handler({ task_id, worker, new_instruction }) {
      const workerAgentId = stripAgentPrefix(worker)

      const result = await taskManager.steerTask({
        taskId: task_id,
        worker: workerAgentId,
        newInstruction: new_instruction,
      })

      if (!result.steered) {
        return { steered: false, ...(result.message !== undefined && { message: result.message }) }
      }

      // Send the steer message to the worker with reply_to so the announce path works.
      // source conv_id == task_id (mirrors create-task convention so handleWorkerAnnounce
      // can look up the task by conv_id).
      const source = `internal:task:${task_id}:${agentId}`

      const steerMessage: InboundMessage = {
        source,
        content: new_instruction,
        reply_to: `agent:${agentId}`,
        delegation_id: result.delegation_id,
      }

      await sendToAgent(workerAgentId, steerMessage)

      return { steered: true }
    },
  })
}
