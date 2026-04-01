/**
 * Session-level memory compaction — mirrors agent repo's compactor.ts
 * Uses pai lib directly for summarization (no CLI subprocess).
 */

import { promises as fs } from 'fs'
import { join } from 'path'
import { type Pai } from 'pai'
import type { ChatInput } from 'pai'
import {
  estimateTokens,
  estimateMessageTokens,
  loadSessionMessages,
  writeSessionMessages,
  splitMessages,
  buildTranscript,
  loadCompactState,
  saveCompactState,
  type SessionMessage,
  type CompactState,
} from './session.js'
import type { Logger } from '../logging.js'

const RECENT_RAW_TOKEN_BUDGET = 4096
const COMPACT_INTERVAL_TURNS = 10
const CONTEXT_USAGE_THRESHOLD = 0.8
const SAFETY_MARGIN = 512
const SUMMARY_MARKER = '[Memory Summary]\n'

function isSyntheticSummary(msg: SessionMessage): boolean {
  return msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.startsWith(SUMMARY_MARKER)
}

export interface CompactOptions {
  agentDir: string
  threadId: string
  sessionFile: string
  systemPrompt: string
  userMessage: string
  pai: Pai
  /** Provider name (for selecting provider) */
  provider?: string | undefined
  /** Model name (for selecting model) */
  model?: string | undefined
  contextWindow: number
  maxOutputTokens: number
  logger: Logger
}

export function shouldCompact(
  totalTokens: number,
  inputBudget: number,
  state: { turnCount: number; lastCompactedAt: number },
): boolean {
  const overContext = totalTokens > inputBudget * CONTEXT_USAGE_THRESHOLD
  const overInterval = state.turnCount - state.lastCompactedAt >= COMPACT_INTERVAL_TURNS
  return overContext || overInterval
}

export function estimateTotalTokens(
  systemPrompt: string,
  sessionMessages: SessionMessage[],
  userMessage: string,
): number {
  const systemTokens = estimateTokens(systemPrompt)
  const sessionTokens = sessionMessages.reduce((sum, m) => sum + estimateMessageTokens(m), 0)
  const userTokens = estimateTokens(userMessage) + 4
  return systemTokens + sessionTokens + userTokens
}

function stateFilePath(agentDir: string, threadId: string): string {
  return join(agentDir, 'sessions', `compact-state-${threadId}.json`)
}

export interface CompactResult {
  compacted: boolean
  reason?: 'threshold' | 'interval'
  before_tokens?: number
  after_tokens?: number
  budget_tokens?: number
}

export async function compactSession(opts: CompactOptions): Promise<CompactResult> {
  const { agentDir, threadId, sessionFile, systemPrompt, userMessage, pai, provider, model, contextWindow, maxOutputTokens, logger } = opts

  const inputBudget = contextWindow - maxOutputTokens - SAFETY_MARGIN
  const statePath = stateFilePath(agentDir, threadId)
  const state: CompactState = await loadCompactState(statePath)

  state.turnCount += 1

  const messages = await loadSessionMessages(sessionFile)
  if (messages.length === 0) {
    await saveCompactState(statePath, state)
    return { compacted: false }
  }

  const totalTokens = estimateTotalTokens(systemPrompt, messages, userMessage)

  if (!shouldCompact(totalTokens, inputBudget, state)) {
    await saveCompactState(statePath, state)
    return { compacted: false }
  }

  const overContext = totalTokens > inputBudget * CONTEXT_USAGE_THRESHOLD
  const reason: 'threshold' | 'interval' = overContext ? 'threshold' : 'interval'

  const usagePct = Math.round((totalTokens / inputBudget) * 100)
  logger.info(`Compacting session for thread ${threadId} (tokens≈${totalTokens}, budget=${inputBudget}, turn=${state.turnCount}, usage=${usagePct}%)`)

  const systemMessages = messages.filter((m) => m.role === 'system')
  const conversationMessages = messages.filter((m) => m.role !== 'system' && !isSyntheticSummary(m))
  const { toSummarize, recentRaw } = splitMessages(conversationMessages, RECENT_RAW_TOKEN_BUDGET)

  if (toSummarize.length === 0) {
    logger.info(`Nothing to summarize for thread ${threadId}, skipping compaction`)
    state.lastCompactedAt = state.turnCount
    await saveCompactState(statePath, state)
    return { compacted: false }
  }

  let summaryText: string | null = null
  try {
    summaryText = await generateSummary(agentDir, threadId, toSummarize, pai, provider, model, logger)
  } catch (err) {
    logger.error(`Summarization failed for thread ${threadId}: ${err instanceof Error ? err.message : String(err)} — falling back to truncation`)
  }

  const newMessages: SessionMessage[] = [
    ...systemMessages,
    ...(summaryText
      ? [{ role: 'assistant' as const, content: `${SUMMARY_MARKER}${summaryText}`, timestamp: new Date().toISOString() }]
      : []),
    ...recentRaw,
  ]

  // If still over budget after compaction, halve recentRaw
  const rewrittenTokens = estimateTotalTokens(systemPrompt, newMessages, userMessage)
  if (rewrittenTokens > inputBudget) {
    logger.info(`Post-compaction still over budget (${rewrittenTokens}), trimming recentRaw further`)
    const halvedBudget = Math.floor(RECENT_RAW_TOKEN_BUDGET / 2)
    const { recentRaw: trimmed } = splitMessages(conversationMessages, halvedBudget)
    newMessages.splice(systemMessages.length + (summaryText ? 1 : 0))
    newMessages.push(...trimmed)
  }

  await writeSessionMessages(sessionFile, newMessages)

  if (summaryText) {
    const memoryDir = join(agentDir, 'memory')
    await fs.mkdir(memoryDir, { recursive: true })
    await fs.writeFile(join(memoryDir, `thread-${threadId}.md`), summaryText, 'utf-8')
    logger.info(`Thread memory updated for ${threadId}`)
  }

  state.lastCompactedAt = state.turnCount
  await saveCompactState(statePath, state)

  const newTokens = estimateTotalTokens(systemPrompt, newMessages, userMessage)
  const newPct = Math.round((newTokens / inputBudget) * 100)
  logger.info(`Session compaction complete for thread ${threadId} (tokens≈${newTokens}, usage=${newPct}%)`)

  return { compacted: true, reason, before_tokens: totalTokens, after_tokens: newTokens, budget_tokens: inputBudget }
}

const SUMMARIZER_SYSTEM_PROMPT = `You are compressing the memory of an AI agent. The summary you produce will be injected into the agent's system prompt for future conversations. Write in second person ("You previously...") so the agent can read it as its own memory.

Produce a structured markdown summary with these sections (omit sections with no relevant content):
## Key Facts
Established facts, user preferences, confirmed information.
## Decisions Made
Choices agreed upon or actions taken.
## Open Questions
Unresolved issues or pending tasks.
## Tool Outputs
Important results from tool calls worth remembering.
## Context
Any other context needed to continue the conversation naturally.

Be concise. Omit small talk and redundant exchanges.`

async function generateSummary(
  agentDir: string,
  threadId: string,
  toSummarize: SessionMessage[],
  pai: Pai,
  provider: string | undefined,
  model: string | undefined,
  logger: Logger,
): Promise<string> {
  const memoryPath = join(agentDir, 'memory', `thread-${threadId}.md`)
  let existingSummary: string | null = null
  try {
    existingSummary = await fs.readFile(memoryPath, 'utf-8')
  } catch {
    // No existing summary — first compaction
  }

  const transcript = buildTranscript(toSummarize)
  const turnCount = toSummarize.filter((m) => m.role === 'user').length

  const userMessage = existingSummary
    ? `You have an existing memory summary from earlier in this conversation:\n\n--- EXISTING SUMMARY ---\n${existingSummary}\n--- END SUMMARY ---\n\nNow compress the following NEW conversation turns (${turnCount} user turn(s)) and merge them into an updated summary:\n\n--- NEW CONVERSATION ---\n${transcript}\n--- END CONVERSATION ---\n\nProduce a single updated summary that incorporates both the existing summary and the new turns.`
    : `Compress the following conversation (${turnCount} user turn(s)) into a structured memory summary:\n\n--- CONVERSATION ---\n${transcript}\n--- END CONVERSATION ---`

  logger.info(`Requesting summary for ${toSummarize.length} messages in thread ${threadId}${existingSummary ? ' (incremental)' : ''}`)

  const chatInput: ChatInput = {
    system: SUMMARIZER_SYSTEM_PROMPT,
    history: [],
    userMessage,
  }

  const controller = new AbortController()
  let reply = ''
  for await (const event of pai.chat(chatInput, { provider, model, stream: false }, null, [], controller.signal)) {
    if (event.type === 'chat_end' && event.newMessages.length > 0) {
      const last = event.newMessages[event.newMessages.length - 1]
      if (last && last.role === 'assistant') {
        reply = typeof last.content === 'string' ? last.content : JSON.stringify(last.content)
      }
    }
  }

  return reply
}
