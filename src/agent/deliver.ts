/**
 * Delivery system - sends streaming tokens and responses back to xgw via IPC
 */

import type { ReplyContext } from '../types.js'
import type { IpcConnection } from '../ipc/types.js'

export class Deliver {
  constructor(private conn: IpcConnection, private replyContext: ReplyContext) {}

  async streamStart(sessionId: string): Promise<void> {
    await this.conn.send({
      type: 'stream_start',
      reply_context: this.replyContext,
      session_id: sessionId,
    })
  }

  async streamToken(sessionId: string, token: string): Promise<void> {
    await this.conn.send({
      type: 'stream_token',
      session_id: sessionId,
      token,
    })
  }

  async streamThinking(sessionId: string, delta: string): Promise<void> {
    await this.conn.send({
      type: 'stream_thinking',
      session_id: sessionId,
      delta,
    })
  }

  async streamToolCall(sessionId: string, toolCall: unknown): Promise<void> {
    await this.conn.send({
      type: 'stream_tool_call',
      session_id: sessionId,
      tool_call: toolCall,
    })
  }

  async streamToolResult(sessionId: string, toolResult: unknown): Promise<void> {
    await this.conn.send({
      type: 'stream_tool_result',
      session_id: sessionId,
      tool_result: toolResult,
    })
  }

  async streamEnd(sessionId: string): Promise<void> {
    await this.conn.send({
      type: 'stream_end',
      session_id: sessionId,
    })
  }

  async streamError(sessionId: string, error: string): Promise<void> {
    await this.conn.send({
      type: 'stream_error',
      session_id: sessionId,
      error,
    })
  }

  async streamCtxUsage(sessionId: string, totalTokens: number, budgetTokens: number): Promise<void> {
    await this.conn.send({
      type: 'stream_ctx_usage',
      reply_context: this.replyContext,
      session_id: sessionId,
      ctx_usage: {
        total_tokens: totalTokens,
        budget_tokens: budgetTokens,
        pct: budgetTokens > 0 ? Math.round((totalTokens / budgetTokens) * 100) : 0,
      },
    })
  }

  async streamCompactStart(sessionId: string, reason: 'threshold' | 'interval'): Promise<void> {
    await this.conn.send({
      type: 'stream_compact_start',
      reply_context: this.replyContext,
      session_id: sessionId,
      compact_start: { reason },
    })
  }

  async streamCompactEnd(sessionId: string, beforeTokens: number, afterTokens: number): Promise<void> {
    await this.conn.send({
      type: 'stream_compact_end',
      reply_context: this.replyContext,
      session_id: sessionId,
      compact_end: { before_tokens: beforeTokens, after_tokens: afterTokens },
    })
  }
}
