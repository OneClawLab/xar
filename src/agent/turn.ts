/**
 * Shared single-turn processing core.
 *
 * Both `run-loop.ts` (daemon mode) and `chat.ts` (CLI REPL) call `processTurn()`
 * with different callbacks so delivery logic stays separate while the core
 * pipeline (compact → ctx_usage → chat → retry → write-back) is shared.
 */

import { chat, createBashExecTool } from 'pai'
import type { ChatInput, ChatConfig, Message, Tool } from 'pai'
import type { Writable } from 'node:stream'
import { compactSession } from './memory.js'
import { estimateTokens, loadSessionMessages, writeSessionMessages } from './session.js'
import type { SessionMessage } from './session.js'
import type { Logger } from '../logging.js'
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'

// ── Constants ────────────────────────────────────────────────────────────────

const CONTEXT_WINDOW_DEFAULT = 128_000
const MAX_OUTPUT_TOKENS_DEFAULT = 4096
const SAFETY_MARGIN = 512

// ── Public types ─────────────────────────────────────────────────────────────

export interface TurnCallbacks {
  onCompactStart(reason: 'threshold' | 'interval'): void | Promise<void>
  onCompactEnd(beforeTokens: number, afterTokens: number): void | Promise<void>
  onCtxUsage(totalTokens: number, budgetTokens: number, pct: number): void | Promise<void>
  onStreamStart(): void | Promise<void>
  onStreamEnd(): void | Promise<void>
  onStreamError(error: string): void | Promise<void>
  onThinkingDelta(delta: string): void | Promise<void>
  onToolCall(toolCall: { name: string; arguments: unknown }): void | Promise<void>
  onToolResult(result: unknown): void | Promise<void>
}

export interface TurnParams {
  chatInput: ChatInput
  chatConfig: ChatConfig
  /** Writable stream for token chunks (stdout for CLI, IpcChunkWriter for daemon) */
  tokenWriter: Writable | null
  /** Session file path for compact */
  sessionFile: string
  agentDir: string
  threadId: string
  /** Provider-level context window (from pai config); falls back to 128K */
  contextWindow?: number | undefined
  /** Provider-level max output tokens; falls back to 4096 */
  maxOutputTokens?: number | undefined
  /** Max retry attempts */
  maxAttempts: number
  logger: Logger
  callbacks: TurnCallbacks
  /** Extra tools beyond the default bash_exec */
  extraTools?: Tool[]
}

export interface TurnResult {
  /** New messages produced by the LLM (assistant + tool records) */
  newMessages: Message[]
}

// ── Core ─────────────────────────────────────────────────────────────────────

/**
 * Estimate total input tokens from a ChatInput (system + history + userMessage).
 */
export function estimateChatInputTokens(input: ChatInput): number {
  let total = estimateTokens(input.system ?? '')
  for (const m of input.history ?? []) {
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    total += estimateTokens(text) + 4
  }
  const userText = typeof input.userMessage === 'string' ? input.userMessage : JSON.stringify(input.userMessage)
  total += estimateTokens(userText) + 4
  return total
}

/**
 * Compute the input token budget for a given context window.
 */
export function computeInputBudget(contextWindow?: number, maxOutputTokens?: number): {
  contextWindow: number
  maxOutputTokens: number
  inputBudget: number
} {
  const cw = contextWindow ?? CONTEXT_WINDOW_DEFAULT
  const mo = maxOutputTokens ?? MAX_OUTPUT_TOKENS_DEFAULT
  return { contextWindow: cw, maxOutputTokens: mo, inputBudget: cw - mo - SAFETY_MARGIN }
}

/**
 * Process a single conversation turn: compact → ctx_usage → LLM chat → retry.
 *
 * Returns the new messages produced by the LLM so the caller can persist them.
 */
export async function processTurn(params: TurnParams): Promise<TurnResult> {
  const {
    chatInput, chatConfig, tokenWriter, sessionFile, agentDir, threadId,
    maxAttempts, logger, callbacks, extraTools,
  } = params

  const { contextWindow: cw, maxOutputTokens: mo, inputBudget } = computeInputBudget(
    params.contextWindow, params.maxOutputTokens,
  )

  const tools: Tool[] = [createBashExecTool(), ...(extraTools ?? [])]

  // ── 1. Compact + ctx_usage ──────────────────────────────────────────────

  try {
    const compactResult = await compactSession({
      agentDir,
      threadId,
      sessionFile,
      systemPrompt: chatInput.system ?? '',
      userMessage: typeof chatInput.userMessage === 'string' ? chatInput.userMessage : JSON.stringify(chatInput.userMessage),
      provider: chatConfig.provider,
      model: chatConfig.model,
      apiKey: chatConfig.apiKey,
      contextWindow: cw,
      maxOutputTokens: mo,
      logger,
    })

    if (compactResult.compacted) {
      await callbacks.onCompactStart(compactResult.reason ?? 'threshold')
      await callbacks.onCompactEnd(compactResult.before_tokens ?? 0, compactResult.after_tokens ?? 0)
      const totalTokens = compactResult.after_tokens ?? 0
      const budget = compactResult.budget_tokens ?? inputBudget
      const pct = budget > 0 ? Math.round((totalTokens / budget) * 100) : 0
      await callbacks.onCtxUsage(totalTokens, budget, pct)
    } else {
      const totalTokens = estimateChatInputTokens(chatInput)
      const pct = inputBudget > 0 ? Math.round((totalTokens / inputBudget) * 100) : 0
      await callbacks.onCtxUsage(totalTokens, inputBudget, pct)
    }
  } catch (err) {
    logger.warn(`Session compact failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
  }

  // ── 2. LLM chat with retry ─────────────────────────────────────────────

  const newMessages: Message[] = []

  try {
    await callbacks.onStreamStart()
    logger.info(`Stream started: model=${chatConfig.model}`)

    const controller = new AbortController()

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        logger.info(`LLM call: attempt=${attempt + 1}/${maxAttempts} provider=${chatConfig.provider} model=${chatConfig.model}`)

        for await (const event of chat(chatInput, chatConfig, tokenWriter, tools, controller.signal)) {
          if (event.type === 'thinking_delta') {
            await callbacks.onThinkingDelta(event.delta)
          }
          if (event.type === 'tool_call') {
            await callbacks.onToolCall({ name: event.name, arguments: event.args })
          }
          if (event.type === 'tool_result') {
            await callbacks.onToolResult(event.result)
          }
          if (event.type === 'chat_end') {
            for (const m of event.newMessages) {
              newMessages.push(m)
            }
          }
        }

        logger.info(`LLM call succeeded: attempt=${attempt + 1}`)
        break
      } catch (err) {
        const lastError = err instanceof Error ? err : new Error(String(err))
        const msg = lastError.message.toLowerCase()
        const isRetryable =
          msg.includes('timeout') ||
          msg.includes('rate limit') ||
          msg.includes('network') ||
          msg.includes('econnrefused') ||
          msg.includes('econnreset') ||
          msg.includes('503') ||
          msg.includes('429')

        if (!isRetryable || attempt === maxAttempts - 1) {
          logger.error(`LLM call failed (attempt=${attempt + 1}, retryable=${isRetryable}): ${lastError.message}`)
          throw lastError
        }

        const delay = Math.pow(2, attempt) * 1000
        logger.warn(`LLM call failed (attempt=${attempt + 1}), retrying in ${delay}ms: ${lastError.message}`)
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }

    // ── 3. Persist to session file ───────────────────────────────────────
    try {
      await fs.mkdir(dirname(sessionFile), { recursive: true })
      const existing = await loadSessionMessages(sessionFile)
      const userMsg: SessionMessage = {
        role: 'user',
        content: typeof chatInput.userMessage === 'string' ? chatInput.userMessage : JSON.stringify(chatInput.userMessage),
        timestamp: new Date().toISOString(),
      }
      const newSessionMsgs: SessionMessage[] = newMessages.map((m) => ({
        role: m.role as SessionMessage['role'],
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        timestamp: new Date().toISOString(),
        ...(m.name !== undefined && { name: m.name }),
        ...(m.tool_call_id !== undefined && { tool_call_id: m.tool_call_id }),
        ...(m.tool_calls !== undefined && { tool_calls: m.tool_calls }),
      }))
      await writeSessionMessages(sessionFile, [...existing, userMsg, ...newSessionMsgs])
    } catch (err) {
      logger.warn(`Failed to write session file (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
    }

    await callbacks.onStreamEnd()
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    logger.error(`Turn failed: ${errorMsg}`)
    await callbacks.onStreamError(errorMsg)
    throw err
  }

  return { newMessages }
}
