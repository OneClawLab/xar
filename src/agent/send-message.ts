/**
 * send_message tool — allows the agent to send messages to peers or other agents.
 *
 * Exported helpers (splitTarget, findPeerSource, deliverToPeer, deliverToAgent)
 * are also used directly by run-loop.ts for summary turn delivery.
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
  logger: Logger
  /** Per-agent stream sequence counter, shared with run-loop */
  nextStreamSeq: () => number
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse target string into [prefix, id].
 * e.g. "peer:alice" → ["peer", "alice"], "agent:bot1" → ["agent", "bot1"]
 * If no colon found, prefix is the whole string and id is empty.
 *
 * 调用方：send_message tool handler、run-loop.ts 的 announceWorkerResult /
 * deliverSummaryResult / handleProcessingError。
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
 *
 * 调用方：deliverToPeer（投递前定位 peer 的 channel 地址）。
 * 也被 run-loop.ts 的 deliverSummaryResult 间接使用（通过 deliverToPeer）。
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

/**
 * 通过 IPC streaming 把消息投递给 human peer（经由 xgw → TUI/Telegram 等）。
 *
 * 流程：从 thread history 里找 peer 最近的 external source → 解析出
 * OutboundTarget → 发 stream_start/token/end 三帧 → 写 thread record。
 *
 * 调用方：
 * - send_message tool handler（LLM 主动调用 send_message(target="peer:...")）
 * - run-loop.ts deliverSummaryResult（create_task 全部完成后把 summary 推给发起人）
 */
export async function deliverToPeer(
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

/**
 * 通过 daemon 内部路由把消息投递给另一个 agent（fire-and-forget）。
 *
 * 流程：构造 internal source → 调用 sendToAgent callback（daemon 注入）→
 * 写 thread record。不设 reply_to，接收方不会自动 announce 回来。
 *
 * 调用方：
 * - send_message tool handler（LLM 主动调用 send_message(target="agent:...")）
 */
export async function deliverToAgent(
  deps: SendMessageDeps,
  agentId: string,
  content: string,
): Promise<{ status: string; target?: string; message?: string }> {
  const { agentId: selfAgentId, convId, sendToAgent, threadStore, logger } = deps

  if (!sendToAgent) {
    return { status: 'error', message: 'agent not running' }
  }

  // 1. Construct internal source
  const source = `internal:agent:${convId}:${selfAgentId}`
  const targetStr = `agent:${agentId}`

  // 2. Send to agent — pure fire-and-forget, no reply_to or task_context injected
  const delivered = sendToAgent(agentId, {
    source,
    content,
  })
  if (!delivered) {
    return { status: 'error', message: 'agent not running' }
  }

  // 3. Write thread record
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

const SEND_MESSAGE_TOOL_DESC = `
Send a one-way notification to a peer or agent. Fire-and-forget — no reply is returned to you.

Allowed uses:
- Send a progress update or intermediate notification to a human peer (target="peer:<id>")
- Notify another agent of something without expecting a response (target="agent:<id>")

NEVER use this to delegate work to an agent and collect results.
If you need an agent to do work and return results to you, use create_task instead.
Using send_message for delegation will silently discard the agent's reply.

Your normal text response is automatically delivered to the current peer — you do not need send_message for that.
`.trim();

/**
 * 创建 send_message LLM tool，注入运行时依赖。
 *
 * 每次 Turn 开始前由 run-loop.ts 的 executeTurn 调用，把当前 Turn 的
 * threadStore、ipcConn、sendToAgent 等上下文绑定进去，返回给 processTurn 使用。
 */
export function createSendMessageTool(deps: SendMessageDeps): Tool {
  return {
    name: 'send_message',
    description: SEND_MESSAGE_TOOL_DESC,
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
          return await deliverToAgent(deps, id, content)
        default:
          return { status: 'error', message: 'invalid target format' }
      }
    },
  }
}
