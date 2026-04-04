/**
 * LLM context builder - assembles system prompt and message history for LLM calls
 */

import type { ThreadStore } from 'thread'
import type { ChatInput, Message, MessageContent } from 'pai'
import { promises as fs } from 'fs'
import { join } from 'path'
import { getDaemonConfig } from '../config.js'
import type { AgentConfig } from './types.js'
import type { InboundMessage } from '../types.js'
import { parseSource } from './router.js'

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
  if (threadId) await tryRead(`thread-${threadId}.md`, 'Thread Memory')

  return parts.join('\n\n')
}

/**
 * Convert ThreadStore events to Message[] for LLM context
 */
async function loadThreadHistory(threadStore: ThreadStore): Promise<Message[]> {
  const events = await threadStore.peek({ lastEventId: 0, limit: 1000 })

  const messages: Message[] = []

  for (const event of events) {
    if (event.type === 'message') {
      // User message from external source
      messages.push({
        role: 'user',
        content: event.content,
      })
    } else if (event.type === 'record') {
      // Record from previous LLM turn — content may be a JSON-serialized envelope
      // containing { content, tool_calls?, tool_call_id?, name? }
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
        const msg: Message = {
          role: 'assistant',
          content: parsed ? (parsed['content'] as MessageContent) : event.content,
        }
        if (parsed?.['tool_calls'] !== undefined) {
          ;(msg as any).tool_calls = parsed['tool_calls']
        }
        messages.push(msg)
      } else if (event.source.startsWith('tool:')) {
        const toolName = event.source.substring('tool:'.length)
        const toolCallId = parsed?.['tool_call_id']
        messages.push({
          role: 'tool',
          content: parsed ? (parsed['content'] as MessageContent) : event.content,
          name: (parsed?.['name'] as string | undefined) ?? toolName,
          ...(typeof toolCallId === 'string' && toolCallId ? { tool_call_id: toolCallId } : {}),
        })
      }
    }
  }

  return messages
}

/**
 * Extract peer ID from source address
 */
function extractPeerId(source: string): string | undefined {
  const [type, id] = source.split(':')
  if (type === 'peer') {
    return id
  }
  return undefined
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
 * Build Communication Context section for the system prompt.
 * Tells the LLM about its identity, current conversation, and available targets.
 */
export async function buildCommunicationContext(
  agentId: string,
  source: string,
  threadStore: ThreadStore,
  availableAgents: string[],
): Promise<string> {
  const parsed = parseSource(source)
  const otherAgents = availableAgents.filter((a) => a !== agentId)
  const agentList = otherAgents.length > 0
    ? otherAgents.map((a) => `agent:${a}`).join(', ')
    : '(none)'

  const lines: string[] = ['## Communication Context']

  if (parsed.kind === 'external') {
    lines.push(`- You are agent: ${agentId}`)

    if (parsed.conversation_type === 'dm') {
      lines.push(`- Conversation: dm with peer:${parsed.peer_id} (via ${parsed.channel_id})`)
    } else {
      lines.push(`- Conversation: ${parsed.conversation_type} ${parsed.conversation_id} (via ${parsed.channel_id})`)
    }

    lines.push(`- Current message from: peer:${parsed.peer_id}`)

    // For group conversations, extract recent participants
    if (parsed.conversation_type !== 'dm') {
      try {
        const events = await threadStore.peek({ lastEventId: 0, limit: 500 })
        const participants = extractRecentParticipants(events)
        if (participants.length > 0) {
          lines.push(`- Recent participants: ${participants.join(', ')}`)
        }
      } catch {
        // skip if thread peek fails
      }
    }

    lines.push(`- Your text response will be streamed to peer:${parsed.peer_id}`)
    lines.push(`- Available agents: ${agentList}`)
    lines.push('- Use send_message tool for messages to other targets')
  } else if (parsed.kind === 'internal') {
    // Worker context: clear, focused, no confusion about delivery
    lines.push(`- You are agent: ${agentId}`)
    lines.push(`- Message from: agent:${parsed.sender_agent_id}`)
    lines.push('- Your text response will be automatically reported back to the sender agent.')
    lines.push('- Do NOT use send_message to contact external peers.')
    lines.push('- Focus only on completing the assigned task and returning your result as plain text.')
    lines.push(`- Available agents: ${agentList}`)
  }

  return lines.join('\n')
}

/**
 * Build LLM context from agent config, thread history, and memory.
 * threadId is required so we can load the per-thread memory summary.
 */
export async function buildContext(
  agentId: string,
  config: AgentConfig,
  threadStore: ThreadStore,
  message: InboundMessage,
  threadId: string,
  availableAgents?: string[],
): Promise<ChatInput> {
  const peerId = extractPeerId(message.source)
  const [identity, memory, history, commContext] = await Promise.all([
    loadIdentity(agentId),
    loadMemory(agentId, peerId, threadId),
    loadThreadHistory(threadStore),
    buildCommunicationContext(agentId, message.source, threadStore, availableAgents ?? []),
  ])

  // task_context is injected by the orchestrator when dispatching a task via
  // send_message(target='agent:...'). It describes the worker's role and constraints.
  const parts = [identity, memory, commContext, message.task_context ?? ''].filter(Boolean)
  const systemPrompt = parts.join('\n\n')

  return {
    system: systemPrompt,
    history,
    userMessage: message.content,
  }
}
