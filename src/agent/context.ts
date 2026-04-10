/**
 * LLM context builder - assembles system prompt and message history for LLM calls
 */

import type { ThreadStore } from 'thread'
import type { ChatInput, Message, MessageContent } from 'pai'
import type { MessageWithToolCalls } from '../types.js'
import { promises as fs } from 'fs'
import { join } from 'path'
import { getDaemonConfig } from '../config.js'
import type { AgentConfig } from './types.js'
import type { InboundMessage } from '../types.js'
import { parseSource } from './router.js'
import { loadCompactState } from './session.js'

/**
 * Agent role for the current Turn, determined by detectRole.
 * Maps to Communication Context scenarios A-F from the design doc.
 */
export type AgentRole =
  | 'front-reactive'
  | 'front-autonomous'
  | 'worker'
  | 'worker-synthesizing'
  | 'orchestrator-synthesizing'
  | 'orchestrator-waiting'
  | 'participant'

/**
 * Task summary context passed to detectRole to inform role detection.
 * Populated by the run-loop from TaskManager state before each Turn.
 */
export interface TaskSummaryContext {
  hasPendingTasks: boolean
  isSummaryTurn: boolean
  taskId?: string
  subtaskResults?: Array<{ worker: string; instruction: string; result?: string; status: string }>
  replyTarget?: string
}

/**
 * Detect the agent's role for the current Turn based on the inbound message,
 * agent config, and optional task context.
 *
 * Logic (Property 7 from design doc):
 * - external source + hasPendingTasks           → 'orchestrator-waiting'
 * - external source + no pending tasks + reactive → 'front-reactive'
 * - external source + no pending tasks + autonomous → 'front-autonomous'
 * - internal source + isSummaryTurn + has reply_to → 'worker-synthesizing'
 * - internal source + isSummaryTurn + no reply_to  → 'orchestrator-synthesizing'
 * - internal source + not summary + has reply_to   → 'worker'
 * - internal source + not summary + no reply_to    → 'participant'
 * - fallback                                        → 'front-reactive'
 */
export function detectRole(
  message: InboundMessage,
  config: AgentConfig,
  taskContext?: TaskSummaryContext,
): AgentRole {
  const parsed = parseSource(message.source)

  if (parsed.kind === 'external') {
    if (taskContext?.hasPendingTasks) return 'orchestrator-waiting'
    return config.routing.mode === 'reactive' ? 'front-reactive' : 'front-autonomous'
  }

  if (parsed.kind === 'internal') {
    if (taskContext?.isSummaryTurn) {
      return message.reply_to ? 'worker-synthesizing' : 'orchestrator-synthesizing'
    }
    return message.reply_to ? 'worker' : 'participant'
  }

  return 'front-reactive'
}

/**
 * Load agent identity (system prompt)
 */
export async function loadIdentity(agentId: string): Promise<string> {
  const config = getDaemonConfig()
  const identityPath = join(config.theClawHome, 'agents', agentId, 'IDENTITY.md')

  try {
    return await fs.readFile(identityPath, 'utf-8')
  } catch {
    // Return default identity if file doesn't exist
    return `You are agent ${agentId}. Respond helpfully to user queries.`
  }
}

/**
 * Load agent memory (cross-session context) — three layers:
 *   1. agent.md       — cross-peer/thread agent-level memory
 *   2. user-<id>.md   — per-peer cross-thread memory
 *   3. thread-<id>.md — per-thread compressed summary (distinct from session compact:
 *                       session compact preserves task-relevant context within a session,
 *                       while thread memory is a durable long-term summary across sessions,
 *                       especially important for long-lived threads like per-agent routing)
 */
async function loadMemory(agentId: string, peerId?: string, threadId?: string): Promise<string> {
  const config = getDaemonConfig()
  const memoryDir = join(config.theClawHome, 'agents', agentId, 'memory')

  const parts: string[] = []

  const tryRead = async (file: string, label: string): Promise<void> => {
    try {
      const content = await fs.readFile(join(memoryDir, file), 'utf-8')
      if (content.trim()) parts.push(`## ${label}\n${content}`)
    } catch {
      // Ignore if doesn't exist
    }
  }

  await tryRead('agent.md', 'Agent Memory')
  if (peerId) await tryRead(`user-${peerId}.md`, 'Peer Memory')
  if (threadId) {
    const safeId = threadId.replace(/[\\/]/g, '-')
    await tryRead(`thread-${safeId}.md`, 'Thread Memory')
  }

  return parts.join('\n\n')
}

/**
 * Convert ThreadStore events to Message[] for LLM context.
 * fromEventId: only load events with id > fromEventId (0 = load all).
 * Returns messages paired with their event ids for compact bookmarking.
 */
async function loadThreadHistory(
  threadStore: ThreadStore,
  fromEventId: number,
): Promise<{ messages: Message[]; eventIds: number[] }> {
  const events = await threadStore.peek({ lastEventId: fromEventId, limit: 1000 })

  const messages: Message[] = []
  const eventIds: number[] = []

  for (const event of events) {
    if (event.type === 'message') {
      messages.push({ role: 'user', content: event.content })
      eventIds.push(event.id)
    } else if (event.type === 'record') {
      let parsed: Record<string, unknown> | null = null
      try {
        const candidate = JSON.parse(event.content) as unknown
        if (candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate) && 'content' in candidate) {
          parsed = candidate as Record<string, unknown>
        }
      } catch {
        // plain string content — no envelope
      }

      if (event.source === 'self') {
        const msg: MessageWithToolCalls = {
          role: 'assistant',
          content: parsed ? (parsed['content'] as MessageContent) : event.content,
        }
        if (parsed?.['tool_calls'] !== undefined) {
          msg.tool_calls = parsed['tool_calls'] as NonNullable<MessageWithToolCalls['tool_calls']>
        }
        messages.push(msg)
        eventIds.push(event.id)
      } else if (event.source.startsWith('tool:')) {
        const toolName = event.source.substring('tool:'.length)
        const toolCallId = parsed?.['tool_call_id']
        messages.push({
          role: 'tool',
          content: parsed ? (parsed['content'] as MessageContent) : event.content,
          name: (parsed?.['name'] as string | undefined) ?? toolName,
          ...(typeof toolCallId === 'string' && toolCallId ? { tool_call_id: toolCallId } : {}),
        })
        eventIds.push(event.id)
      }
    }
  }

  return { messages, eventIds }
}

/**
 * Extract peer ID from source address
 */
function extractPeerId(source: string): string | undefined {
  try {
    return parseSource(source).peer_id
  } catch {
    return undefined
  }
}

/**
 * Extract distinct peer_ids from thread events with external sources.
 */
function extractRecentParticipants(events: { source: string }[]): string[] {
  const seen = new Set<string>()
  for (const ev of events) {
    if (!ev.source.startsWith('external:')) continue
    try {
      const parsed = parseSource(ev.source)
      if (parsed.peer_id) seen.add(parsed.peer_id)
    } catch {
      // skip malformed sources
    }
  }
  return [...seen]
}

/**
 * Format the conversation line for front-facing scenarios (A/B).
 */
function formatConversationLine(parsed: ReturnType<typeof parseSource>): string {
  return parsed.conversation_type === 'dm'
    ? `Conversation: dm with peer:${parsed.peer_id} (via ${parsed.channel_id})`
    : `Conversation: ${parsed.conversation_type ?? 'unknown'} ${parsed.conversation_id ?? ''} (via ${parsed.channel_id ?? ''})`
}

/**
 * Explanation of the receive_user_update mechanism injected at the end of every
 * Communication Context section (Requirement 7.4).
 */
const RECEIVE_USER_UPDATE_EXPLANATION = `
A special tool \`receive_user_update\` may appear in your tool call history.
It carries real-time updates from the user during task execution.
Treat its content as refinements to your current task, not a new request.`.trimStart()

/**
 * Build Communication Context section for the system prompt.
 * Uses detectRole to select the appropriate scenario template (A-F).
 *
 * Scenarios (from design doc §10, Requirements 6.1-6.7):
 *   A: front-reactive       — identity, conversation, message source, reply target, available agents
 *   B: front-autonomous     — identity, conversation, participants, self-decide whether to respond
 *   C: worker               — identity, delegator, task, DO NOT send_message
 *   D: worker-synthesizing  — identity, delegator, subtask results, Do NOT delegate further
 *   E: orchestrator-synthesizing — task ID, origin, subtask results, reply target
 *   F: orchestrator-waiting — task ID, subtask statuses, optional progress update
 */
export async function buildCommunicationContext(
  agentId: string,
  message: InboundMessage,
  config: AgentConfig,
  threadStore: ThreadStore,
  availableAgents: string[],
  taskContext?: TaskSummaryContext,
): Promise<string> {
  const role = detectRole(message, config, taskContext)
  const parsed = parseSource(message.source)
  const otherAgents = availableAgents.filter((a) => a !== agentId)
  const agentList = otherAgents.length > 0
    ? otherAgents.map((a) => `agent:${a}`).join(', ')
    : '(none)'

  const lines: string[] = ['## Communication Context']

  switch (role) {
    case 'front-reactive': {
      // Scenario A
      lines.push(`You are: agent:${agentId}`)
      lines.push(formatConversationLine(parsed))
      lines.push(`Current message from: peer:${parsed.peer_id}`)
      lines.push(`Your text response will be delivered to: peer:${parsed.peer_id}`)
      lines.push(`Available agents: ${agentList}`)
      break
    }

    case 'front-autonomous': {
      // Scenario B
      lines.push(`You are: agent:${agentId}`)
      lines.push(formatConversationLine(parsed))
      // Extract participants from thread history
      try {
        const events = await threadStore.peek({ lastEventId: 0, limit: 500 })
        const participants = extractRecentParticipants(events)
        if (participants.length > 0) {
          lines.push(`Participants: ${participants.join(', ')}`)
        }
      } catch {
        // skip if thread peek fails
      }
      lines.push('You decide whether to respond. An empty response means silence.')
      lines.push(`Available agents: ${agentList}`)
      break
    }

    case 'worker': {
      // Scenario C
      lines.push(`You are: agent:${agentId}`)
      lines.push(`Delegated by: agent:${parsed.sender_agent_id}`)
      lines.push('Task: <message content is the task>')
      lines.push('DO NOT use send_message to reply. Your text response will be automatically reported back.')
      lines.push(`Available agents: ${agentList} (for sub-delegation only)`)
      break
    }

    case 'worker-synthesizing': {
      // Scenario D
      lines.push(`You are: agent:${agentId}`)
      lines.push(`Delegated by: agent:${parsed.sender_agent_id}`)
      lines.push('Subtask results:')
      if (taskContext?.subtaskResults && taskContext.subtaskResults.length > 0) {
        for (const st of taskContext.subtaskResults) {
          lines.push(`- worker: ${st.worker}, status: ${st.status}, result: ${st.result ?? '(none)'}`)
        }
      }
      lines.push('Synthesize the results above into a final answer. Do NOT delegate further.')
      lines.push('Your text response will be automatically reported back.')
      break
    }

    case 'orchestrator-synthesizing': {
      // Scenario E
      lines.push(`You are: agent:${agentId}`)
      lines.push(`Task ID: ${taskContext?.taskId ?? '(unknown)'}`)
      lines.push(`Origin: ${taskContext?.replyTarget ?? '(unknown)'}`)
      lines.push('All subtasks completed:')
      if (taskContext?.subtaskResults && taskContext.subtaskResults.length > 0) {
        for (const st of taskContext.subtaskResults) {
          lines.push(`- worker: ${st.worker}, status: ${st.status}, result: ${st.result ?? '(none)'}`)
        }
      }
      lines.push(`Your text response will be delivered to: ${taskContext?.replyTarget ?? '(unknown)'}`)
      break
    }

    case 'orchestrator-waiting': {
      // Scenario F
      lines.push(`You are: agent:${agentId}`)
      lines.push(`Task ID: ${taskContext?.taskId ?? '(unknown)'}`)
      lines.push('Waiting for subtasks:')
      if (taskContext?.subtaskResults && taskContext.subtaskResults.length > 0) {
        for (const st of taskContext.subtaskResults) {
          lines.push(`- worker: ${st.worker}, status: ${st.status}`)
        }
      }
      lines.push('You may optionally send a progress update to the user.')
      break
    }

    case 'participant': {
      // Participant: notified but no reply expected
      lines.push(`You are: agent:${agentId}`)
      lines.push(`Message from: agent:${parsed.sender_agent_id}`)
      lines.push('You are a participant in this conversation. No reply is expected.')
      lines.push(`Available agents: ${agentList}`)
      break
    }
  }

  lines.push('')
  lines.push(RECEIVE_USER_UPDATE_EXPLANATION)

  return lines.join('\n')
}

/**
 * Build LLM context from agent config, thread history, and memory.
 * threadId is required so we can load the per-thread memory summary.
 * taskContext is optional and used to inform role detection and context generation.
 *
 * Returns chatInput plus eventIds (parallel array to history) for compact bookmarking.
 */
export async function buildContext(
  agentId: string,
  config: AgentConfig,
  threadStore: ThreadStore,
  message: InboundMessage,
  threadId: string,
  availableAgents?: string[],
  taskContext?: TaskSummaryContext,
): Promise<{ chatInput: ChatInput; eventIds: number[] }> {
  const config_ = getDaemonConfig()
  const agentDir = join(config_.theClawHome, 'agents', agentId)
  const safeId = threadId.replace(/[\\/]/g, '-')
  const statePath = join(agentDir, 'memory', `thread-${safeId}.compact-state.json`)

  const compactState = await loadCompactState(statePath)
  const fromEventId = compactState.compactedUpToEventId ?? 0

  const peerId = extractPeerId(message.source)
  const [identity, memory, { messages: history, eventIds }, commContext] = await Promise.all([
    loadIdentity(agentId),
    loadMemory(agentId, peerId, threadId),
    loadThreadHistory(threadStore, fromEventId),
    buildCommunicationContext(agentId, message, config, threadStore, availableAgents ?? [], taskContext),
  ])

  const parts = [identity, memory, commContext].filter(Boolean)
  const systemPrompt = parts.join('\n\n')

  return {
    chatInput: {
      system: systemPrompt,
      history,
      userMessage: message.content,
    },
    eventIds,
  }
}
