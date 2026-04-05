/**
 * Mid-Turn Injection: checks for new Human messages during a Turn's tool call
 * sequence and injects them as a receive_user_update virtual tool call + result pair.
 *
 * Requirements: 7.1, 7.2, 7.3
 */

import type { ThreadStore } from 'thread'
import type { Message } from 'pai'
import type { MessageWithToolCalls } from '../types.js'

export interface MidTurnInjectionResult {
  messages: Message[]
  newLastCheckedId: number
}

export class MidTurnInjector {
  constructor(private readonly threadStore: ThreadStore) {}

  /**
   * Check for new Human messages since lastCheckedEventId.
   * If found, construct a receive_user_update tool call + result pair,
   * write the injection to the thread as type=record, subtype=mid_turn_injection,
   * and return the message pair with the updated lastCheckedId.
   * Returns null if no new Human messages are found.
   */
  async checkAndInject(lastCheckedEventId: number): Promise<MidTurnInjectionResult | null> {
    // Query events after lastCheckedEventId
    let events
    try {
      events = await this.threadStore.peek({ lastEventId: lastCheckedEventId, limit: 100 })
    } catch {
      // If thread read fails, skip injection (per design doc error handling)
      return null
    }

    // Filter for external Human messages (type=message, source starts with 'external:')
    const newMessages = events.filter(
      (e) => e.type === 'message' && e.source.startsWith('external:'),
    )

    if (newMessages.length === 0) {
      return null
    }

    // The last event id among all queried events (not just Human messages)
    // so we advance the cursor past everything we've seen
    const lastEvent = events[events.length - 1]
    // newMessages is non-empty so this is safe
    const lastNewEvent = newMessages[newMessages.length - 1]
    const newLastCheckedId = Math.max(
      lastEvent?.id ?? lastCheckedEventId,
      lastNewEvent?.id ?? lastCheckedEventId,
    )

    // Build the virtual tool call id
    const toolCallId = `receive_user_update_${Date.now()}`

    // Combine all new Human message contents
    const combinedContent = newMessages.map((e) => e.content).join('\n')

    // Assistant message with the virtual tool call
    const assistantMsg: MessageWithToolCalls = {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: toolCallId,
          type: 'function',
          function: {
            name: 'receive_user_update',
            arguments: '{}',
          },
        },
      ],
    }

    // Tool result message
    const toolMsg: Message = {
      role: 'tool',
      name: 'receive_user_update',
      tool_call_id: toolCallId,
      content: combinedContent,
    }

    // Write the injection record to the thread
    try {
      await this.threadStore.push({
        source: 'self',
        type: 'record',
        subtype: 'mid_turn_injection',
        content: JSON.stringify({
          messages: newMessages.map((e) => e.content),
        }),
      })
    } catch {
      // Non-fatal: if write fails, still return the messages so the Turn continues
    }

    return {
      messages: [assistantMsg, toolMsg],
      newLastCheckedId,
    }
  }
}
