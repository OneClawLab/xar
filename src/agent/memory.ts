/**
 * Session-level memory compaction
 * Operates directly on chatInput.history (from thread events), not a separate session file.
 */

import { promises as fs } from 'fs'
import { join, dirname } from 'path'
import { type Pai } from 'pai'
import type { ChatInput } from 'pai'
import {
  estimateTokens,
  estimateMessageTokens,
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

export interface CompactOptions {
  agentDir: string
  threadId: string
  /** chatInput history to compact (from thread events via buildContext) */
  history: SessionMessage[]
  /** Parallel array of SQLite event ids for each message in history */
  eventIds: number[]
  systemPrompt: string
  userMessage: string
  pai: Pai
  provider?: string | undefined
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
  const safeId = threadId.replace(/[\\/]/g, '-')
  return join(agentDir, 'sessions', `compact-state-${safeId}.json`)
}

export interface CompactResult {
  compacted: boolean
  reason?: 'threshold' | 'interval'
  before_tokens?: number
  after_tokens?: number
  budget_tokens?: number
  /** Compacted history to replace chatInput.history with, if compacted=true */
  newHistory?: SessionMessage[]
}

export async function compactSession(opts: CompactOptions): Promise<CompactResult> {
  const { agentDir, threadId, history, eventIds, systemPrompt, userMessage, pai, provider, model, contextWindow, maxOutputTokens, logger } = opts

  const inputBudget = contextWindow - maxOutputTokens - SAFETY_MARGIN
  const safeId = threadId.replace(/[\\/]/g, '-')
  const statePath = stateFilePath(agentDir, threadId)
  const state: CompactState = await loadCompactState(statePath)

  state.turnCount += 1

  if (history.length === 0) {
    await saveCompactState(statePath, state)
    return { compacted: false }
  }

  const totalTokens = estimateTotalTokens(systemPrompt, history, userMessage)

  if (!shouldCompact(totalTokens, inputBudget, state)) {
    await saveCompactState(statePath, state)
    return { compacted: false }
  }

  const overContext = totalTokens > inputBudget * CONTEXT_USAGE_THRESHOLD
  const reason: 'threshold' | 'interval' = overContext ? 'threshold' : 'interval'

  const usagePct = Math.round((totalTokens / inputBudget) * 100)
  logger.info(`Compacting session for thread ${threadId} (tokens≈${totalTokens}, budget=${inputBudget}, turn=${state.turnCount}, usage=${usagePct}%)`)

  const systemMessages = history.filter((m) => m.role === 'system')
  const conversationMessages = history.filter((m) => m.role !== 'system')
  const { toSummarize, recentRaw } = splitMessages(conversationMessages, RECENT_RAW_TOKEN_BUDGET)

  if (toSummarize.length === 0) {
    logger.info(`Nothing to summarize for thread ${threadId}, skipping compaction`)
    state.lastCompactedAt = state.turnCount
    await saveCompactState(statePath, state)
    return { compacted: false }
  }

  let summaryText: string | null = null
  try {
    summaryText = await generateSummary(agentDir, safeId, toSummarize, pai, provider, model, logger)
  } catch (err) {
    logger.error(`Summarization failed for thread ${threadId}: ${err instanceof Error ? err.message : String(err)} — falling back to truncation`)
  }

  const newHistory: SessionMessage[] = [
    ...systemMessages,
    // Note: summary is injected via system prompt (memory/thread-*.md), not as a synthetic message in history
    ...recentRaw,
  ]

  // If still over budget after compaction, halve recentRaw
  const rewrittenTokens = estimateTotalTokens(systemPrompt, newHistory, userMessage)
  if (rewrittenTokens > inputBudget) {
    logger.info(`Post-compaction still over budget (${rewrittenTokens}), trimming recentRaw further`)
    const halvedBudget = Math.floor(RECENT_RAW_TOKEN_BUDGET / 2)
    const { recentRaw: trimmed } = splitMessages(conversationMessages, halvedBudget)
    newHistory.splice(systemMessages.length + (summaryText ? 1 : 0))
    newHistory.push(...trimmed)
  }

  if (summaryText) {
    const memoryFile = join(agentDir, 'memory', `thread-${safeId}.md`)
    await fs.mkdir(dirname(memoryFile), { recursive: true })
    await fs.writeFile(memoryFile, summaryText, 'utf-8')
    logger.info(`Thread memory updated for ${threadId}`)
  }

  state.lastCompactedAt = state.turnCount

  // Find the event id of the last message that was summarized away.
  // recentRaw messages are kept; everything before them is compacted.
  // We find the index of recentRaw[0] in the original history to get the boundary.
  if (recentRaw.length > 0) {
    const firstKeptIdx = history.indexOf(recentRaw[0]!)
    if (firstKeptIdx > 0 && eventIds.length > 0) {
      // The event id just before the first kept message is the compact boundary
      const lastCompactedIdx = firstKeptIdx - 1
      const lastCompactedEventId = eventIds[lastCompactedIdx]
      if (lastCompactedEventId !== undefined) {
        state.compactedUpToEventId = lastCompactedEventId
      }
    }
  } else if (history.length > 0 && eventIds.length > 0) {
    // Everything was summarized
    state.compactedUpToEventId = eventIds[eventIds.length - 1] ?? state.compactedUpToEventId
  }

  await saveCompactState(statePath, state)

  const newTokens = estimateTotalTokens(systemPrompt, newHistory, userMessage)
  const newPct = Math.round((newTokens / inputBudget) * 100)
  logger.info(`Session compaction complete for thread ${threadId} (tokens≈${newTokens}, usage=${newPct}%)`)

  return { compacted: true, reason, before_tokens: totalTokens, after_tokens: newTokens, budget_tokens: inputBudget, newHistory }
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
  safeId: string,
  toSummarize: SessionMessage[],
  pai: Pai,
  provider: string | undefined,
  model: string | undefined,
  logger: Logger,
): Promise<string> {
  const memoryPath = join(agentDir, 'memory', `thread-${safeId}.md`)
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

  logger.info(`Requesting summary for ${toSummarize.length} messages in thread ${safeId}${existingSummary ? ' (incremental)' : ''}`)

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
