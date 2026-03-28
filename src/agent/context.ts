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
 * Build LLM context from agent config, thread history, and memory.
 * threadId is required so we can load the per-thread memory summary.
 */
export async function buildContext(
  agentId: string,
  config: AgentConfig,
  threadStore: ThreadStore,
  message: InboundMessage,
  threadId: string,
): Promise<ChatInput> {
  const peerId = extractPeerId(message.source)
  const [identity, memory, history] = await Promise.all([
    loadIdentity(agentId),
    loadMemory(agentId, peerId, threadId),
    loadThreadHistory(threadStore),
  ])

  const systemPrompt = [identity, memory].filter(Boolean).join('\n')

  return {
    system: systemPrompt,
    history,
    userMessage: message.content,
  }
}
