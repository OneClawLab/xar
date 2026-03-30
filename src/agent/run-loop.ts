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
import type { Logger } from '../logging.js'
import { compactSession } from './memory.js'
import { estimateTokens } from './session.js'
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
    this.logger.info(`Processing message: source=${msg.source} channel=${msg.reply_context.channel_id} peer=${msg.reply_context.peer_id}`)

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

    // Build LLM context first so we have systemPrompt for accurate token estimation
    const chatInput = await buildContext(this.agentId, config, threadStore, msg, threadId)
    this.logger.debug('LLM context built')

    const tools: Tool[] = [createBashExecTool()]

    const conn = this.getConn()
    if (!conn) {
      this.logger.error(`No IPC connection available for streaming (active connections: ${this.ipcConnections.size})`)
      throw new Error('No IPC connection available for streaming')
    }
    this.logger.debug(`Using IPC connection: ${conn.id}`)

    // Run session compact with real systemPrompt + userMessage for accurate token count
    const CONTEXT_WINDOW = 128000
    const MAX_OUTPUT_TOKENS = 4096
    const SAFETY_MARGIN = 512
    const inputBudget = CONTEXT_WINDOW - MAX_OUTPUT_TOKENS - SAFETY_MARGIN

    const chunkWriter = new IpcChunkWriter(conn, msg.reply_context)
    const deliver = new Deliver(conn, msg.reply_context)
    const sessionId = `${msg.reply_context.channel_id}:${msg.reply_context.session_id}`

    try {
      const compactResult = await compactSession({
        agentDir,
        threadId,
        sessionFile,
        systemPrompt: chatInput.system ?? '',
        userMessage: msg.content,
        provider: config.pai.provider,
        model: config.pai.model,
        apiKey: provider.apiKey,
        contextWindow: CONTEXT_WINDOW,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        logger: this.logger,
      })
      if (compactResult.compacted) {
        await deliver.streamCompactStart(sessionId, compactResult.reason ?? 'threshold')
        await deliver.streamCompactEnd(sessionId, compactResult.before_tokens ?? 0, compactResult.after_tokens ?? 0)
        await deliver.streamCtxUsage(sessionId, compactResult.after_tokens ?? 0, compactResult.budget_tokens ?? inputBudget)
      } else {
        // Not compacted — estimate ctx_usage from the actual LLM context (history + system + user)
        let totalTokens = estimateTokens(chatInput.system ?? '')
        for (const m of chatInput.history ?? []) {
          const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
          totalTokens += estimateTokens(text) + 4
        }
        totalTokens += estimateTokens(msg.content) + 4
        await deliver.streamCtxUsage(sessionId, totalTokens, inputBudget)
      }
    } catch (err) {
      this.logger.warn(`Session compact failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
    }

    try {
      await deliver.streamStart(sessionId)
      this.logger.info(`Stream started: session=${sessionId} model=${config.pai.model}`)

      const controller = new AbortController()
      const maxAttempts = config.retry.max_attempts
      let lastError: Error | null = null

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          this.logger.info(`LLM call: attempt=${attempt + 1}/${maxAttempts} provider=${config.pai.provider} model=${config.pai.model}`)

          for await (const event of chat(chatInput, chatConfig, chunkWriter, tools, controller.signal)) {
            if (event.type === 'thinking_delta') {
              await deliver.streamThinking(sessionId, event.delta)
            }

            if (event.type === 'tool_call') {
              await deliver.streamToolCall(sessionId, { name: event.name, arguments: event.args })
            }

            if (event.type === 'tool_result') {
              await deliver.streamToolResult(sessionId, event.result)
            }

            if (event.type === 'chat_end') {
              const threadEvents = event.newMessages.map((m: any) => {
                // Serialize the full message so tool_call_id / tool_calls are preserved
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
              this.logger.info(`LLM response written to thread: ${threadEvents.length} events`)
            }
          }

          this.logger.info(`LLM call succeeded: attempt=${attempt + 1}`)
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
            this.logger.error(`LLM call failed (attempt=${attempt + 1}, retryable=${isRetryable}): ${lastError.message}`)
            throw lastError
          }

          const delay = Math.pow(2, attempt) * 1000
          this.logger.warn(`LLM call failed (attempt=${attempt + 1}), retrying in ${delay}ms: ${lastError.message}`)
          await new Promise((resolve) => setTimeout(resolve, delay))
        }
      }

      await deliver.streamEnd(sessionId)
      this.logger.info(`Message processed successfully: session=${sessionId}`)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      this.logger.error(`Message processing failed: session=${sessionId} error=${errorMsg}`)
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
