/**
 * spawn_adhoc_task tool — spawns a short-lived anonymous LLM task in an isolated context.
 *
 * Wraps pai.chat() directly. The adhoc task runs with a fresh context (no session history),
 * making it suitable for self-contained reasoning that doesn't require a persistent named agent.
 *
 * Key differences from create_agent_task:
 *   - No agent identity (no IDENTITY.md, no persistent session)
 *   - Context is fully isolated from the caller's session
 *   - Synchronous result — caller awaits the output directly
 *   - Not steer-able or cancel-able mid-flight
 *   - Supports concurrent execution of multiple independent subtasks
 */

import { defineTool } from 'pai'
import type { Pai } from 'pai'

// ── Tool I/O types ────────────────────────────────────────────────────────────

export interface SpawnAdhocTaskToolInput {
  instruction: string
  context?: string
}

export interface SpawnAdhocTaskToolOutput {
  result: string
}

// ── Factory ──────────────────────────────────────────────────────────────────

export interface SpawnAdhocTaskToolDeps {
  pai: Pai
  provider: string
  model: string
}

const SPAWN_ADHOC_TASK_TOOL_DESC = `
Spawn a short-lived anonymous LLM task in an isolated context.
Use this for self-contained reasoning, analysis, or generation that doesn't require a persistent named agent.
The task runs with a fresh context — no session history, no agent identity.
Supports concurrent execution: you may call this tool multiple times in parallel for independent subtasks.
Do NOT use this for tasks that require collaboration with a named agent (use create_agent_task instead).
Do NOT spawn further agent tasks from within an adhoc task — adhoc tasks are terminal.
`.trim()

export function createSpawnAdhocTaskTool(deps: SpawnAdhocTaskToolDeps) {
  const { pai, provider, model } = deps

  return defineTool<SpawnAdhocTaskToolInput, SpawnAdhocTaskToolOutput>({
    name: 'spawn_adhoc_task',
    description: SPAWN_ADHOC_TASK_TOOL_DESC,
    parameters: {
      type: 'object',
      properties: {
        instruction: {
          type: 'string',
          description: 'The full prompt/instruction for the adhoc task',
        },
        context: {
          type: 'string',
          description: 'Optional additional context to inject (e.g. relevant data, constraints)',
        },
      },
      required: ['instruction'],
    },

    async handler({ instruction, context }) {
      const userContent = context !== undefined
        ? `${context}\n\n${instruction}`
        : instruction

      const input = { userMessage: userContent }
      let resultText = ''

      for await (const event of pai.chat(input, { provider, model, stream: false })) {
        if (event.type === 'chat_end') {
          for (const m of event.newMessages) {
            if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
              resultText = m.content.trim()
            }
          }
        }
      }

      return { result: resultText }
    },
  })
}
