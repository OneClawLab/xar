/**
 * Message router - routes inbox messages to target threads based on routing config
 */

import type { ThreadStore } from 'thread'
import type { InboundMessage } from '../types.js'
import type { AgentConfig } from './types.js'
import { openOrCreateThread } from './thread-lib.js'

/**
 * Parse thread source address format: <type>:<id>
 * Examples:
 *   - peer:user123
 *   - session:sess456
 *   - agent:admin
 */
function parseSource(source: string): { type: string; id: string } {
  const [type, id] = source.split(':')
  if (!type || !id) {
    throw new Error(`Invalid source format: ${source}`)
  }
  return { type, id }
}

/**
 * Determine target thread ID based on routing config and message source
 */
export function determineThreadId(config: AgentConfig, source: string): string {
  const { type, id } = parseSource(source)
  const routing = config.routing.default

  switch (routing) {
    case 'per-peer':
      // One thread per peer, regardless of session
      return `peer-${id}`

    case 'per-session':
      // One thread per session
      if (type !== 'session') {
        throw new Error(`per-session routing requires session source, got ${type}`)
      }
      return `session-${id}`

    case 'per-agent':
      // Single thread for entire agent
      return 'main'

    default:
      throw new Error(`Unknown routing mode: ${routing}`)
  }
}

/**
 * Route an inbound message to the appropriate thread
 * Returns the ThreadStore for that thread
 */
export async function routeMessage(
  agentId: string,
  config: AgentConfig,
  message: InboundMessage,
): Promise<ThreadStore> {
  const threadId = determineThreadId(config, message.source)
  return openOrCreateThread(agentId, threadId)
}
