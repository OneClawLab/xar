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
  const routing = config.routing.default

  switch (routing) {
    case 'per-peer': {
      // One thread per peer
      const peerId = parsed.peer_id ?? parsed.sender_agent_id ?? 'unknown'
      return `peers/${peerId}`
    }

    case 'per-conversation': {
      // One thread per conversation
      const convId = parsed.conversation_id ?? 'unknown'
      return `conversations/${convId}`
    }

    case 'per-agent':
      // Single thread for entire agent
      return 'main'

    default:
      throw new Error(`Unknown routing mode: ${routing}`)
  }
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
