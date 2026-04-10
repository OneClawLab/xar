/**
 * Session message handling and compaction state management
 */

import { promises as fs } from 'fs'
import { join, dirname } from 'path'
export interface SessionMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  timestamp?: string
  name?: string
  tool_call_id?: string
  tool_calls?: unknown[]
}

export interface CompactState {
  turnCount: number
  lastCompactedAt: number
  /** The last SQLite event id that was summarized away. Next load starts from this id + 1. 0 = no compaction yet. */
  compactedUpToEventId: number
}

/**
 * Language-aware token estimator
 * - CJK, fullwidth, emoji (cp > 0x2E7F): ~1.5 tokens/char
 * - Latin extended, accented (cp > 0x007F): ~0.7 tokens/char
 * - ASCII (cp ≤ 0x007F): ~0.25 tokens/char
 */
export function estimateTokens(text: string): number {
  let tokens = 0
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0
    if (cp > 0x2E7F) {
      tokens += 1.5
    } else if (cp > 0x007F) {
      tokens += 0.7
    } else {
      tokens += 0.25
    }
  }
  return Math.ceil(tokens)
}

/**
 * Estimate tokens for a single session message
 */
export function estimateMessageTokens(msg: SessionMessage): number {
  const contentStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
  return estimateTokens(contentStr) + 4
}

/**
 * Split messages into toSummarize and recentRaw
 */
export function splitMessages(
  messages: SessionMessage[],
  recentTokenBudget: number,
): { toSummarize: SessionMessage[]; recentRaw: SessionMessage[] } {
  const nonSystem = messages.filter((m) => m.role !== 'system')

  const recentRaw: SessionMessage[] = []
  let accumulated = 0

  for (let i = nonSystem.length - 1; i >= 0; i--) {
    const msg = nonSystem[i]!
    const t = estimateMessageTokens(msg)
    if (accumulated + t <= recentTokenBudget) {
      recentRaw.unshift(msg)
      accumulated += t
    } else {
      break
    }
  }

  const recentSet = new Set(recentRaw)
  const toSummarize = nonSystem.filter((m) => !recentSet.has(m))

  return { toSummarize, recentRaw }
}

/**
 * Build transcript from messages
 */
export function buildTranscript(messages: SessionMessage[]): string {
  const lines: string[] = []
  let turnIndex = 0
  let i = 0

  while (i < messages.length) {
    const msg = messages[i]!

    if (msg.role === 'user') {
      turnIndex++
      lines.push(`[Turn ${turnIndex}]`)
      lines.push(`User: ${msg.content}`)
      i++
      continue
    }

    if (msg.role === 'assistant') {
      const toolCalls = msg.tool_calls as Array<{ name?: string; arguments?: unknown }> | undefined
      if (toolCalls?.length) {
        lines.push(`Assistant called tool \`${toolCalls[0]?.name ?? '?'}\` with: ${JSON.stringify(toolCalls[0]?.arguments ?? {})}`)
      } else {
        lines.push(`Assistant: ${msg.content}`)
      }
      i++
      continue
    }

    if (msg.role === 'tool') {
      lines.push(`Tool result (${msg.name ?? '?'}): ${msg.content}`)
      i++
      continue
    }

    i++
  }

  return lines.join('\n')
}

/**
 * Get compact state file path
 */
export function compactStatePath(theClawHome: string, agentId: string, threadId: string): string {
  const safeId = threadId.replace(/[\\/]/g, '-')
  return join(theClawHome, 'agents', agentId, 'sessions', `compact-state-${safeId}.json`)
}

/**
 * Load compact state
 */
export async function loadCompactState(statePath: string): Promise<CompactState> {
  try {
    const raw = await fs.readFile(statePath, 'utf-8')
    return JSON.parse(raw) as CompactState
  } catch {
    return { turnCount: 0, lastCompactedAt: 0, compactedUpToEventId: 0 }
  }
}

/**
 * Save compact state
 */
export async function saveCompactState(statePath: string, state: CompactState): Promise<void> {
  const dir = dirname(statePath)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(statePath, JSON.stringify(state), 'utf-8')
}
