/**
 * send_message tool — allows the agent to send messages to peers or other agents.
 *
 * Exported helpers (splitTarget, findPeerSource) are also used by tests.
 */

import type { Tool } from 'pai'
import type { ThreadStore, ThreadEvent } from 'thread'
import type { InboundMessage, OutboundTarget } from '../types.js'
import type { IpcConnection } from '../ipc/types.js'
import type { Logger } from '../logging.js'
import { parseSource } from './router.js'
import { Deliver } from './deliver.js'

// ── Types ────────────────────────────────────────────────────────────────────

export interface SendMessageDeps {
  agentId: string
  threadStore: ThreadStore
  ipcConn: IpcConnection | undefined
  sendToAgent: ((agentId: string, message: InboundMessage) => boolean) | undefined
  convId: string
  /** OutboundTarget of the current inbound message's peer, if external.
   *  Passed to deliverToAgent so the worker can auto-announce back to the peer. */
  currentPeerTarget: OutboundTarget | undefined
  logger: Logger
  /** Per-agent stream sequence counter, shared with run-loop */
  nextStreamSeq: () => number
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse target string into [prefix, id].
 * e.g. "peer:alice" → ["peer", "alice"], "agent:bot1" → ["agent", "bot1"]
 * If no colon found, prefix is the whole string and id is empty.
 */
export function splitTarget(target: string): [string, string] {
  const idx = target.indexOf(':')
  if (idx === -1) return [target, '']
  return [target.substring(0, idx), target.substring(idx + 1)]
}

/**
 * Scan thread events from end to find the most recent external source
 * that contains the given peerId.
 * Scans from the tail (most recent) so long threads don't miss recent events.
 */
export function findPeerSource(events: ThreadEvent[], peerId: string): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!
    const src = ev.source
    if (!src.startsWith('external:')) continue
    try {
      const parsed = parseSource(src)
      if (parsed.peer_id === peerId) return src
    } catch {
      // skip malformed sources
    }
  }
  return undefined
}

// ── Delivery functions ───────────────────────────────────────────────────────

async function deliverToPeer(
  deps: SendMessageDeps,
  peerId: string,
  content: string,
): Promise<{ status: string; target?: string; message?: string }> {
  const { threadStore, ipcConn, logger, nextStreamSeq } = deps

  // 1. Scan thread for peer's external source — scan from tail for recency
  let events: ThreadEvent[]
  try {
    events = await threadStore.peek({ lastEventId: 0, limit: 2000 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error(`Failed to peek thread events: ${msg}`)
    return { status: 'error', message: `thread peek failed: ${msg}` }
  }

  const source = findPeerSource(events, peerId)
  if (!source) {
    return { status: 'error', message: 'peer not found in thread context' }
  }

  // 2. Parse OutboundTarget
  const parsed = parseSource(source)
  if (!parsed.channel_id || !parsed.peer_id || !parsed.conversation_id) {
    return { status: 'error', message: 'invalid peer source format' }
  }

  const target: OutboundTarget = {
    channel_id: parsed.channel_id,
    peer_id: parsed.peer_id,
    conversation_id: parsed.conversation_id,
  }

  // 3. Check IPC connection
  if (!ipcConn) {
    return { status: 'error', message: 'no IPC connection available' }
  }

  // 4. Stream: start → token → end
  const seq = nextStreamSeq()
  const streamId = `${target.channel_id}:${target.conversation_id}:${seq}`
  const targetStr = `peer:${peerId}`

  try {
    const deliver = new Deliver(ipcConn, target)
    await deliver.streamStart(streamId)
    await deliver.streamToken(streamId, content)
    await deliver.streamEnd(streamId)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error(`IPC delivery failed: ${msg}`)
    return { status: 'error', message: msg }
  }

  // 5. Write thread record
  try {
    await threadStore.push({
      source: 'self',
      type: 'record',
      subtype: 'message',
      content: JSON.stringify({ target: targetStr, content }),
    })
  } catch (err) {
    logger.warn(`Failed to write send_message record: ${err instanceof Error ? err.message : String(err)}`)
    // Delivery already succeeded — still return delivered
  }

  return { status: 'delivered', target: targetStr }
}

async function deliverToAgent(
  deps: SendMessageDeps,
  agentId: string,
  content: string,
  replyToPeer?: OutboundTarget,
): Promise<{ status: string; target?: string; message?: string }> {
  const { agentId: selfAgentId, convId, sendToAgent, threadStore, logger } = deps

  if (!sendToAgent) {
    return { status: 'error', message: 'agent not running' }
  }

  // 1. Construct internal source
  const source = `internal:agent:${convId}:${selfAgentId}`
  const targetStr = `agent:${agentId}`

  // 2. Build task context injected into the worker's system prompt
  const taskContext = [
    '[Task Assignment]',
    `You are handling a delegated task from agent:${selfAgentId}.`,
    'Complete the task and return your result as plain text.',
    'Do NOT use send_message to contact external peers — the framework will deliver your result automatically.',
    'Do NOT pretend to be the orchestrator.',
    'Your text response will be automatically reported back to the orchestrator.',
  ].join('\n')

  // 3. Send to agent — include reply_to_peer so the run-loop can auto-announce
  const delivered = sendToAgent(agentId, {
    source,
    content,
    task_context: taskContext,
    ...(replyToPeer !== undefined ? { reply_to_peer: replyToPeer } : {}),
  })
  if (!delivered) {
    return { status: 'error', message: 'agent not running' }
  }

  // 4. Write thread record
  try {
    await threadStore.push({
      source: 'self',
      type: 'record',
      subtype: 'message',
      content: JSON.stringify({ target: targetStr, content }),
    })
  } catch (err) {
    logger.warn(`Failed to write send_message record: ${err instanceof Error ? err.message : String(err)}`)
  }

  return { status: 'delivered', target: targetStr }
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createSendMessageTool(deps: SendMessageDeps): Tool {
  return {
    name: 'send_message',
    description: `Send a message to a peer or agent outside the normal streaming reply.
Use this when you need to:
- Send a message to a different target than the current conversation peer
- Send an intermediate notification before your main reply
- Dispatch a task to another agent
- Send progress updates during a long task
Your normal text response is automatically streamed to the current peer —
you don't need send_message for that.
When dispatching to an agent, your result will be automatically reported back
to you — the worker does not need to call send_message to reply.`,
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Target address: "peer:<peer_id>" for humans, "agent:<agent_id>" for agents.',
        },
        content: {
          type: 'string',
          description: 'Message content.',
        },
      },
      required: ['target', 'content'],
    },
    async handler(args: unknown): Promise<unknown> {
      const { target, content } = args as { target: string; content: string }
      const [prefix, id] = splitTarget(target)

      switch (prefix) {
        case 'peer':
          return await deliverToPeer(deps, id, content)
        case 'agent':
          // reply_to_peer is intentionally NOT passed here — workers should not
          // directly deliver to the peer by default. The orchestrator synthesizes
          // results and delivers them. Use send_message(target='peer:...') for
          // explicit progress notifications instead.
          return await deliverToAgent(deps, id, content)
        default:
          return { status: 'error', message: 'invalid target format' }
      }
    },
  }
}
