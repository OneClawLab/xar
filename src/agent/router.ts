/**
 * Message router - routes inbound messages to target threads based on agent routing config.
 *
 * Source address format (from ARCH.md):
 *   external:<channel_id>:<conversation_type>:<conversation_id>:<peer_id>
 *   internal:<conversation_type>:<conversation_id>:<sender_agent_id>
 *   self
 *
 * channel_id itself is structured as <channel_type>:<instance> (e.g. "telegram:main").
 */

import type { ThreadStore } from 'thread'
import type { InboundMessage } from '../types.js'
import type { AgentConfig } from './types.js'
import { openOrCreateThread } from './thread-lib.js'

export interface ParsedSource {
  kind: 'external' | 'internal' | 'self'
  channel_id?: string          // e.g. "telegram:main"
  conversation_type?: string   // "dm" | "group" | "channel"
  conversation_id?: string
  peer_id?: string
  sender_agent_id?: string
}

/**
 * Parse the structured source address string.
 */
export function parseSource(source: string): ParsedSource {
  if (source === 'self') {
    return { kind: 'self' }
  }

  const parts = source.split(':')

  if (parts[0] === 'external' && parts.length >= 6) {
    // external:<ch_type>:<ch_instance>:<conv_type>:<conv_id>:<peer_id>
    const channelId = `${parts[1]}:${parts[2]}`
    const conversationType = parts[3]!
    const conversationId = parts[4]!
    const peerId = parts[5]!
    return {
      kind: 'external',
      channel_id: channelId,
      conversation_type: conversationType,
      conversation_id: conversationId,
      peer_id: peerId,
    }
  }

  if (parts[0] === 'internal' && parts.length >= 4) {
    // internal:<conv_type>:<conv_id>:<sender_agent_id>
    const conversationType = parts[1]!
    const conversationId = parts[2]!
    const senderAgentId = parts[3]!
    return {
      kind: 'internal',
      conversation_type: conversationType,
      conversation_id: conversationId,
      sender_agent_id: senderAgentId,
    }
  }

  throw new Error(`Invalid source format: ${source}`)
}

/**
 * Determine target thread ID based on routing config and parsed source.
 */
export function determineThreadId(config: AgentConfig, source: string): string {
  const parsed = parseSource(source)

  // Internal messages always go to per-internal-conv thread
  if (parsed.kind === 'internal') {
    const taskId = parsed.conversation_id ?? 'unknown'
    return `internal/${taskId}`
  }

  // Check override rules first
  if (config.routing.override) {
    const convId = parsed.conversation_id ?? ''
    const peerId = parsed.peer_id ?? ''
    const overrideKey = convId || peerId
    if (overrideKey && config.routing.override[overrideKey]) {
      return config.routing.override[overrideKey]!
    }
  }

  // Derive from mode + conversation_type
  if (config.routing.mode === 'reactive') {
    if (parsed.conversation_type === 'dm' || !parsed.conversation_id) {
      const peerId = parsed.peer_id ?? 'unknown'
      return `peers/${peerId}`
    }
    // group / channel: per-conversation-peer
    const convId = parsed.conversation_id
    const peerId = parsed.peer_id ?? 'unknown'
    return `conversations/${convId}/peers/${peerId}`
  }

  // Autonomous: per-conversation
  const convId = parsed.conversation_id ?? 'unknown'
  return `conversations/${convId}`
}

/**
 * Reconstruct a source string from a ParsedSource object (inverse of parseSource).
 * Used for round-trip testing (Property 11).
 */
export function buildSource(parsed: ParsedSource): string {
  if (parsed.kind === 'self') {
    return 'self'
  }

  if (parsed.kind === 'external') {
    const channelId = parsed.channel_id ?? 'unknown:unknown'
    const convType = parsed.conversation_type ?? 'dm'
    const convId = parsed.conversation_id ?? 'unknown'
    const peerId = parsed.peer_id ?? 'unknown'
    return `external:${channelId}:${convType}:${convId}:${peerId}`
  }

  if (parsed.kind === 'internal') {
    const convType = parsed.conversation_type ?? 'task'
    const convId = parsed.conversation_id ?? 'unknown'
    const sender = parsed.sender_agent_id ?? 'unknown'
    return `internal:${convType}:${convId}:${sender}`
  }

  throw new Error(`Unknown source kind: ${String(parsed.kind)}`)
}

/**
 * Extract conversation ID from a source address.
 * - internal: returns conversation_id (3rd segment)
 * - external: returns conversation_id field
 * - self / unknown: returns empty string
 */
export function extractConvId(source: string): string {
  try {
    const parsed = parseSource(source)
    return parsed.conversation_id ?? ''
  } catch {
    return ''
  }
}

/**
 * Determine the event_type for an inbound message based on AgentConfig routing settings
 * and the message's conversation_type + mentioned fields.
 *
 * Logic (Property 6):
 * - reactive + mention trigger + group + mentioned=false → 'record'
 * - reactive + mention trigger + group + mentioned=true  → 'message'
 * - reactive + mention trigger + dm (or no conv type)   → 'message' (dm always triggers)
 * - reactive + all trigger                              → 'message'
 * - autonomous                                          → 'message' (LLM decides whether to reply)
 */
export function determineEventType(
  config: AgentConfig,
  msg: { conversation_type?: string; mentioned?: boolean },
): 'message' | 'record' {
  if (config.routing.mode === 'autonomous') {
    return 'message'
  }

  // reactive mode
  if (config.routing.trigger === 'all') {
    return 'message'
  }

  // reactive + mention trigger
  const isGroup = msg.conversation_type === 'group' || msg.conversation_type === 'channel'
  if (isGroup && msg.mentioned === false) {
    return 'record'
  }

  return 'message'
}

/**
 * Route an inbound message to the appropriate thread.
 * Returns the ThreadStore for that thread.
 */
export async function routeMessage(
  agentId: string,
  config: AgentConfig,
  message: InboundMessage,
): Promise<ThreadStore> {
  const threadId = determineThreadId(config, message.source)
  return openOrCreateThread(agentId, threadId)
}
