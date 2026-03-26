/**
 * Run-loop - Per-agent message processing loop
 */

import { chat, createBashExecTool, loadConfig, resolveProvider } from 'pai'
import type { ChatConfig, Tool } from 'pai'
import type { InboundMessage } from '../types.js'
import type { AsyncQueue } from './queue.js'
import { loadAgentConfig } from './config.js'
import { routeMessage, determineThreadId } from './router.js'
import { buildContext } from './context.js'
import { Deliver } from './deliver.js'
import { IpcChunkWriter } from '../daemon/ipc-chunk-writer.js'
import type { IpcConnection } from '../ipc/types.js'
import { createAgentLogger } from '../logging.js'
import type { Logger } from '../logging.js'
import { compactSession } from './memory.js'
import { getDaemonConfig } from '../config.js'
import { join } from 'path'

export interface RunLoop {
  start(): Promise<void>
  stop(): Promise<void>
}

export class RunLoopImpl implements RunLoop {
  private stopped = false
  private logger: Logger

  constructor(
    private agentId: string,
    private queue: AsyncQueue<InboundMessage>,
    // Map of active IPC connections — we pick the best one at message-processing time
    private ipcConnections: Map<string, IpcConnection>,
  ) {
    this.logger = createAgentLogger(agentId)
  }

  async start(): Promise<void> {
    this.logger.info('Run-loop started')

    try {
      for await (const msg of this.queue) {
        if (this.stopped) break

        try {
          await this.processMessage(msg)
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err)
          this.logger.error(`Error processing message: ${errorMsg}`)
          // Continue to next message
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      this.logger.error(`Run-loop error: ${errorMsg}`)
    }

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
    this.logger.info(`Processing message from ${msg.source}`)

    const theClawHome = getDaemonConfig().theClawHome
    const config = await loadAgentConfig(this.agentId, theClawHome)

    // Route message to appropriate thread
    const threadStore = await routeMessage(this.agentId, config, msg)
    this.logger.debug('Message routed to thread')

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
    }

    // Derive thread ID (single source of truth via router)
    const threadId = determineThreadId(config, msg.source)
    const agentDir = join(theClawHome, 'agents', this.agentId)
    const sessionFile = join(agentDir, 'sessions', `${threadId}.jsonl`)

    // Build LLM context first so we have systemPrompt for accurate token estimation
    const chatInput = await buildContext(this.agentId, config, threadStore, msg, threadId)
    this.logger.debug('LLM context built')

    // Run session compact with real systemPrompt + userMessage for accurate token count
    try {
      await compactSession({
        agentDir,
        threadId,
        sessionFile,
        systemPrompt: chatInput.system ?? '',
        userMessage: msg.content,
        provider: config.pai.provider,
        model: config.pai.model,
        apiKey: provider.apiKey,
        contextWindow: 128000,
        maxOutputTokens: 4096,
        logger: this.logger,
      })
    } catch (err) {
      this.logger.warn(`Session compact failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
    }

    const tools: Tool[] = [createBashExecTool()]

    const conn = this.getConn()
    if (!conn) {
      throw new Error('No IPC connection available for streaming')
    }

    const chunkWriter = new IpcChunkWriter(conn, msg.reply_context)
    const deliver = new Deliver(conn, msg.reply_context)
    const sessionId = `${msg.reply_context.channel_id}:${msg.reply_context.session_id}`

    try {
      await deliver.streamStart(sessionId)
      this.logger.debug(`Streaming started for session ${sessionId}`)

      const controller = new AbortController()
      const maxAttempts = config.retry.max_attempts
      let lastError: Error | null = null

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          this.logger.debug(`LLM call attempt ${attempt + 1}/${maxAttempts}`)

          for await (const event of chat(chatInput, chatConfig, chunkWriter, tools, controller.signal)) {
            if (event.type === 'thinking_delta') {
              await deliver.streamThinking(sessionId, event.delta)
            }

            if (event.type === 'chat_end') {
              const threadEvents = event.newMessages.map((m: any) => ({
                source: m.role === 'assistant' ? 'self' : `tool:${m.name ?? ''}`,
                type: 'record' as const,
                ...(m.role === 'tool' ? { subtype: 'toolcall' } : {}),
                content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
              }))
              await threadStore.pushBatch(threadEvents)
              this.logger.debug(`Response written to thread (${threadEvents.length} events)`)
            }
          }

          this.logger.info('Message processed successfully')
          lastError = null
          break
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err))

          const msg2 = lastError.message.toLowerCase()
          const isRetryable =
            msg2.includes('timeout') ||
            msg2.includes('rate limit') ||
            msg2.includes('network') ||
            msg2.includes('econnrefused')

          if (!isRetryable || attempt === maxAttempts - 1) {
            this.logger.error(`LLM call failed: ${lastError.message}`)
            throw lastError
          }

          const delay = Math.pow(2, attempt) * 1000
          this.logger.warn(`LLM call failed (attempt ${attempt + 1}), retrying in ${delay}ms`)
          await new Promise((resolve) => setTimeout(resolve, delay))
        }
      }

      await deliver.streamEnd(sessionId)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      await deliver.streamError(sessionId, errorMsg)
      await threadStore.push({
        source: 'system',
        type: 'record',
        subtype: 'error',
        content: errorMsg,
      })
    }
  }

  /**
   * Removed: use determineThreadId from router.ts instead.
   */
}
