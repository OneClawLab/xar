/**
 * Run-loop - Per-agent message processing loop.
 *
 * Concurrency model (per ARCH.md):
 *   - Different agents: concurrent
 *   - Different threads of same agent: concurrent
 *   - Same thread: serial (via per-thread promise chain)
 */

import type { Pai } from 'pai'
import type { InboundMessage, OutboundTarget } from '../types.js'
import type { AsyncQueue } from './queue.js'
import { loadAgentConfig } from './config.js'
import { routeMessage, determineThreadId, parseSource, extractConvId } from './router.js'
import { buildContext } from './context.js'
import { Deliver } from './deliver.js'
import { IpcChunkWriter } from '../daemon/ipc-chunk-writer.js'
import type { IpcConnection } from '../ipc/types.js'
import type { Logger } from '../logging.js'
import { processTurn } from './turn.js'
import { createSendMessageTool } from './send-message.js'
import { getDaemonConfig } from '../config.js'
import { join } from 'path'

/**
 * Extract the final assistant text from a list of new messages produced by a turn.
 * Returns the last non-empty assistant text content, or undefined if none.
 */
function extractAssistantText(messages: any[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== 'assistant') continue
    const content = m.content
    if (typeof content === 'string' && content.trim()) return content.trim()
    if (Array.isArray(content)) {
      const text = content
        .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
        .map((b: any) => b.text as string)
        .join('')
        .trim()
      if (text) return text
    }
  }
  return undefined
}

export interface RunLoop {
  start(): Promise<void>
  stop(): Promise<void>
}

export class RunLoopImpl implements RunLoop {
  private stopped = false
  private logger: Logger
  /** Per-thread serial lock: messages within the same thread queue behind each other */
  private threadLocks = new Map<string, Promise<void>>()
  /** Track in-flight tasks so stop() can wait for them */
  private inflight = new Set<Promise<void>>()
  /** Per-agent monotonic counter for stream_id uniqueness */
  private streamSeq = 0

  constructor(
    private agentId: string,
    private queue: AsyncQueue<InboundMessage>,
    // Map of active IPC connections — we pick the best one at message-processing time
    private ipcConnections: Map<string, IpcConnection>,
    private pai: Pai,
    logger?: Logger,
    /**
     * Optional callback for agent-to-agent reply routing.
     * When a worker finishes processing an internal message, its assistant reply
     * is automatically delivered back to the sender agent via this callback.
     * Provided by the Daemon so the run-loop doesn't need to know about the
     * full agent registry.
     */
    private sendToAgent?: (agentId: string, message: InboundMessage) => boolean,
    private getRunningAgents?: () => string[],
  ) {
    this.logger = logger ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      close: async () => {},
    }
  }

  async start(): Promise<void> {
    this.logger.info('Run-loop started')

    try {
      for await (const msg of this.queue) {
        if (this.stopped) break

        try {
          // Determine thread key so same-thread messages stay serial
          const config = await loadAgentConfig(this.agentId, getDaemonConfig().theClawHome)
          const threadId = determineThreadId(config, msg.source)

          // Chain onto the per-thread lock (serial within thread, concurrent across threads)
          const prev = this.threadLocks.get(threadId) ?? Promise.resolve()
          const task = prev.then(() => this.processMessage(msg)).catch((err) => {
            const errorMsg = err instanceof Error ? err.message : String(err)
            this.logger.error(`Error processing message: ${errorMsg}`)
          })
          this.threadLocks.set(threadId, task)
          this.inflight.add(task)
          void task.then(() => { this.inflight.delete(task) })
        } catch (err) {
          // Config load or routing failed for this message — skip it, keep the loop alive
          const errorMsg = err instanceof Error ? err.message : String(err)
          this.logger.error(`Error dispatching message (skipped): ${errorMsg}`)
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      this.logger.error(`Run-loop error: ${errorMsg}`)
    }

    // Wait for all in-flight tasks to finish
    await Promise.all(this.inflight)
    this.logger.info('Run-loop stopped')
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.queue.close()
  }

  private getConn(): IpcConnection | undefined {
    // Only return connections that are still open — avoids using a stale
    // WebSocket that was closed after the xar send command disconnected.
    for (const conn of this.ipcConnections.values()) {
      if (conn.isOpen()) return conn
    }
    return undefined
  }

  /**
   * Build OutboundTarget from source address.
   * For external sources, extract channel_id, peer_id, conversation_id.
   * For internal sources, there's no outbound target (agent-to-agent doesn't go through xgw).
   */
  private buildTarget(source: string): OutboundTarget | null {
    const parsed = parseSource(source)
    if (parsed.kind === 'external' && parsed.channel_id && parsed.peer_id && parsed.conversation_id) {
      return {
        channel_id: parsed.channel_id,
        peer_id: parsed.peer_id,
        conversation_id: parsed.conversation_id,
      }
    }
    return null
  }

  /**
   * Generate a unique stream_id: <channel_id>:<conversation_id>:<seq>
   */
  private nextStreamId(target: OutboundTarget): string {
    this.streamSeq++
    return `${target.channel_id}:${target.conversation_id}:${this.streamSeq}`
  }

  private async processMessage(msg: InboundMessage): Promise<void> {
    const target = this.buildTarget(msg.source)
    this.logger.info(`Processing message: source=${msg.source}`)

    // Best-effort error reporter
    let deliver: Deliver | null = null
    let streamId = ''
    let threadStore: Awaited<ReturnType<typeof routeMessage>> | null = null

    try {
      const theClawHome = getDaemonConfig().theClawHome
      const config = await loadAgentConfig(this.agentId, theClawHome)

      // Route message to appropriate thread
      threadStore = await routeMessage(this.agentId, config, msg)
      const threadId = determineThreadId(config, msg.source)
      this.logger.info(`Message routed: thread=${threadId}`)

      // Determine event type: 'record' messages are context-only (no LLM trigger)
      const eventType = msg.event_type ?? 'message'

      // Write inbound message to thread
      await threadStore.push({
        source: msg.source,
        type: eventType,
        content: msg.content,
      })

      // Record-only messages: store in thread for context but skip LLM processing
      if (eventType === 'record') {
        this.logger.info(`Record-only message stored (no LLM): thread=${threadId} source=${msg.source}`)
        return
      }

      // Load pai config and resolve provider for context window info
      const providerInfo = await this.pai.getProviderInfo(config.pai.provider)

      const agentDir = join(theClawHome, 'agents', this.agentId)
      const sessionFile = join(agentDir, 'sessions', `${threadId}.jsonl`)

      // Build LLM context
      const availableAgents = this.getRunningAgents?.() ?? []
      const chatInput = await buildContext(this.agentId, config, threadStore, msg, threadId, availableAgents)
      this.logger.debug('LLM context built')

      const isInternal = parseSource(msg.source).kind === 'internal'

      // Resolve conn lazily — right before we need it — so we get the
      // connection state *after* all the async work above (config load,
      // routing, context build).  An earlier getConn() call could return
      // a connection that was already closed by the time we reach here.
      const conn = this.getConn()
      if (!conn && !isInternal) {
        this.logger.warn(`No IPC connection available for streaming (active connections: ${this.ipcConnections.size}), processing without streaming`)
      }
      this.logger.debug(`Using IPC connection: ${conn?.id ?? 'none'}`)

      // Build stream_id and delivery objects
      // Internal messages: suppress Deliver and IpcChunkWriter (no implicit outbound streaming)
      // LLM response still gets written to thread below.
      if (target && !isInternal) {
        streamId = this.nextStreamId(target)
        if (conn) {
          deliver = new Deliver(conn, target)
        }
      } else {
        streamId = `internal:${this.agentId}:${this.streamSeq++}`
      }

      const chunkWriter = (conn && !isInternal) ? new IpcChunkWriter(conn, streamId) : null

      const convId = extractConvId(msg.source)
      const extraEnv: Record<string, string> = {
        XAR_AGENT_ID: this.agentId,
        XAR_CONV_ID: convId,
      }

      const sendMessageTool = createSendMessageTool({
        agentId: this.agentId,
        threadStore,
        ipcConn: conn,
        sendToAgent: this.sendToAgent,
        convId,
        currentPeerTarget: target ?? undefined,
        logger: this.logger,
        nextStreamSeq: () => ++this.streamSeq,
      })

      const result = await processTurn({
        chatInput,
        pai: this.pai,
        provider: config.pai.provider,
        model: config.pai.model,
        stream: true,
        tokenWriter: chunkWriter,
        sessionFile,
        agentDir,
        threadId,
        contextWindow: providerInfo.contextWindow,
        maxOutputTokens: providerInfo.maxTokens,
        maxAttempts: config.retry.max_attempts,
        logger: this.logger,
        extraEnv,
        extraTools: [sendMessageTool],
        callbacks: {
          onCompactStart: (reason) => deliver?.streamCompactStart(streamId, reason),
          onCompactEnd: (before, after) => deliver?.streamCompactEnd(streamId, before, after),
          onCtxUsage: (total, budget, _pct) => deliver?.streamCtxUsage(streamId, total, budget),
          onStreamStart: () => deliver?.streamStart(streamId),
          onStreamEnd: () => deliver?.streamEnd(streamId),
          onStreamError: (error) => deliver?.streamError(streamId, error),
          onThinkingDelta: (delta) => deliver?.streamThinking(streamId, delta),
          onToolCall: (tc) => deliver?.streamToolCall(streamId, tc),
          onToolResult: (tr) => deliver?.streamToolResult(streamId, tr),
        },
      })

      // Write LLM response records to thread
      const threadEvents = result.newMessages.map((m: any) => {
        const serialized = JSON.stringify({
          content: m.content,
          ...(m.tool_calls !== undefined && { tool_calls: m.tool_calls }),
          ...(m.tool_call_id !== undefined && { tool_call_id: m.tool_call_id }),
          ...(m.name !== undefined && { name: m.name }),
        })
        return {
          source: m.role === 'assistant' ? 'self' : `tool:${m.name ?? ''}`,
          type: 'record' as const,
          ...(m.role === 'tool' ? { subtype: 'toolcall' } : {}),
          content: serialized,
        }
      })
      await threadStore.pushBatch(threadEvents)
      this.logger.info(`Message processed successfully: stream=${streamId} records=${threadEvents.length}`)

      // ── Push-based announce (internal messages only) ──────────────────────
      // When a worker finishes processing a task dispatched by another agent,
      // automatically push the LLM text response back to the sender agent.
      // This removes the requirement for the worker LLM to call send_message.
      if (isInternal) {
        const parsed = parseSource(msg.source)
        const senderAgentId = parsed.sender_agent_id
        if (senderAgentId && this.sendToAgent) {
          const assistantText = extractAssistantText(result.newMessages)
          if (assistantText) {
            const announceSource = `internal:agent:${convId}:${this.agentId}`
            const announced = this.sendToAgent(senderAgentId, {
              source: announceSource,
              content: assistantText,
              event_type: 'message',
            })
            if (announced) {
              this.logger.info(`Auto-announce: ${this.agentId} → ${senderAgentId} (${assistantText.length} chars)`)
            } else {
              this.logger.warn(`Auto-announce failed: sender agent ${senderAgentId} not running`)
            }

            // If the original task carried a reply_to_peer, deliver the result
            // directly to the peer as well (best-effort, non-blocking).
            // This is for single-worker scenarios where the orchestrator wants
            // the worker result delivered immediately without a second LLM turn.
            const replyToPeer = msg.reply_to_peer
            if (replyToPeer && conn) {
              const seq = ++this.streamSeq
              const peerStreamId = `${replyToPeer.channel_id}:${replyToPeer.conversation_id}:${seq}`
              const peerDeliver = new Deliver(conn, replyToPeer)
              try {
                await peerDeliver.streamStart(peerStreamId)
                await peerDeliver.streamToken(peerStreamId, assistantText)
                await peerDeliver.streamEnd(peerStreamId)
                this.logger.info(`Auto-deliver to peer: ${replyToPeer.peer_id} via ${replyToPeer.channel_id}`)
              } catch (err) {
                this.logger.warn(`Auto-deliver to peer failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
              }
            }
          }
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      this.logger.error(`Message processing failed: ${errorMsg}`)

      // Persist error record to thread (if thread was opened)
      if (threadStore) {
        try {
          await threadStore.push({
            source: 'self',
            type: 'record',
            subtype: 'error',
            content: errorMsg,
          })
        } catch {
          this.logger.error('Failed to write error record to thread')
        }
      }

      // For internal messages: notify the sender agent that the task failed.
      // Without this, the orchestrator would wait forever for a result that never comes.
      const isInternalMsg = parseSource(msg.source).kind === 'internal'
      if (isInternalMsg) {
        const parsed = parseSource(msg.source)
        const senderAgentId = parsed.sender_agent_id
        if (senderAgentId && this.sendToAgent) {
          const convId = extractConvId(msg.source)
          const failureNotice = `[Task failed] Agent ${this.agentId} encountered an error: ${errorMsg}`
          const announced = this.sendToAgent(senderAgentId, {
            source: `internal:agent:${convId}:${this.agentId}`,
            content: failureNotice,
            event_type: 'message',
          })
          if (!announced) {
            this.logger.warn(`Failed to notify sender agent ${senderAgentId} of task failure`)
          }
        }
      }

      // Try to notify the external client (for external messages)
      try {
        if (deliver) {
          await deliver.streamError(streamId, errorMsg)
        } else if (target) {
          const conn = this.getConn()
          if (conn) {
            await conn.send({
              type: 'stream_error',
              stream_id: streamId || `error:${this.agentId}:${Date.now()}`,
              error: errorMsg,
            })
          }
        }
      } catch {
        this.logger.error('Failed to send error notification to client')
      }
    }
  }
}
