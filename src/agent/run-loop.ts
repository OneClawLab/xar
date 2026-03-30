/**
 * Run-loop - Per-agent message processing loop
 */

import { loadConfig, resolveProvider } from 'pai'
import type { ChatConfig } from 'pai'
import type { InboundMessage } from '../types.js'
import type { AsyncQueue } from './queue.js'
import { loadAgentConfig } from './config.js'
import { routeMessage, determineThreadId } from './router.js'
import { buildContext } from './context.js'
import { Deliver } from './deliver.js'
import { IpcChunkWriter } from '../daemon/ipc-chunk-writer.js'
import type { IpcConnection } from '../ipc/types.js'
import type { Logger } from '../logging.js'
import { processTurn } from './turn.js'
import { getDaemonConfig } from '../config.js'
import { join } from 'path'

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

  constructor(
    private agentId: string,
    private queue: AsyncQueue<InboundMessage>,
    // Map of active IPC connections — we pick the best one at message-processing time
    private ipcConnections: Map<string, IpcConnection>,
    logger?: Logger,
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
    return Array.from(this.ipcConnections.values())[0]
  }

  private async processMessage(msg: InboundMessage): Promise<void> {
    this.logger.info(`Processing message: source=${msg.source} channel=${msg.reply_context.channel_id} peer=${msg.reply_context.peer_id}`)

    // Best-effort error reporter: if anything fails before processTurn,
    // try to notify the client so they don't hang forever.
    let deliver: Deliver | null = null
    let sessionId = ''

    try {
      const theClawHome = getDaemonConfig().theClawHome
      const config = await loadAgentConfig(this.agentId, theClawHome)

      // Route message to appropriate thread
      const threadStore = await routeMessage(this.agentId, config, msg)
      const threadId = determineThreadId(config, msg.source)
      this.logger.info(`Message routed: thread=${threadId}`)

      // Write inbound message to thread
      await threadStore.push({
        source: msg.source,
        type: 'message',
        content: msg.content,
      })

      // Load pai config and resolve provider
      const paiConfig = await loadConfig()
      const provider = await resolveProvider(paiConfig, config.pai.provider)

      const chatConfig: ChatConfig = {
        provider: config.pai.provider,
        model: config.pai.model,
        apiKey: provider.apiKey,
        stream: true,
        ...(provider.provider.api !== undefined && { api: provider.provider.api }),
        ...(provider.provider.baseUrl !== undefined && { baseUrl: provider.provider.baseUrl }),
        ...(provider.provider.reasoning !== undefined && { reasoning: provider.provider.reasoning }),
        ...(provider.provider.contextWindow !== undefined && { contextWindow: provider.provider.contextWindow }),
        ...(provider.provider.maxTokens !== undefined && { maxTokens: provider.provider.maxTokens }),
        ...(provider.provider.providerOptions !== undefined && { providerOptions: provider.provider.providerOptions }),
      }

      const agentDir = join(theClawHome, 'agents', this.agentId)
      const sessionFile = join(agentDir, 'sessions', `${threadId}.jsonl`)

      // Build LLM context
      const chatInput = await buildContext(this.agentId, config, threadStore, msg, threadId)
      this.logger.debug('LLM context built')

      const conn = this.getConn()
      if (!conn) {
        this.logger.error(`No IPC connection available for streaming (active connections: ${this.ipcConnections.size})`)
        throw new Error('No IPC connection available for streaming')
      }
      this.logger.debug(`Using IPC connection: ${conn.id}`)

      const chunkWriter = new IpcChunkWriter(conn, msg.reply_context)
      deliver = new Deliver(conn, msg.reply_context)
      sessionId = `${msg.reply_context.channel_id}:${msg.reply_context.session_id}`

      const result = await processTurn({
        chatInput,
        chatConfig,
        tokenWriter: chunkWriter,
        sessionFile,
        agentDir,
        threadId,
        contextWindow: provider.provider.contextWindow,
        maxOutputTokens: provider.provider.maxTokens,
        maxAttempts: config.retry.max_attempts,
        logger: this.logger,
        callbacks: {
          onCompactStart: (reason) => deliver!.streamCompactStart(sessionId, reason),
          onCompactEnd: (before, after) => deliver!.streamCompactEnd(sessionId, before, after),
          onCtxUsage: (total, budget, _pct) => deliver!.streamCtxUsage(sessionId, total, budget),
          onStreamStart: () => deliver!.streamStart(sessionId),
          onStreamEnd: () => deliver!.streamEnd(sessionId),
          onStreamError: (error) => deliver!.streamError(sessionId, error),
          onThinkingDelta: (delta) => deliver!.streamThinking(sessionId, delta),
          onToolCall: (tc) => deliver!.streamToolCall(sessionId, tc),
          onToolResult: (tr) => deliver!.streamToolResult(sessionId, tr),
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
      this.logger.info(`Message processed successfully: session=${sessionId} records=${threadEvents.length}`)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      this.logger.error(`Message processing failed: ${errorMsg}`)

      // Try to notify the client — deliver may not exist yet if the error
      // happened before IPC setup, so fall back to a raw conn.send().
      try {
        if (deliver) {
          await deliver.streamError(sessionId, errorMsg)
        } else {
          const conn = this.getConn()
          if (conn) {
            await conn.send({
              type: 'stream_error',
              session_id: `${msg.reply_context.channel_id}:${msg.reply_context.session_id}`,
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
