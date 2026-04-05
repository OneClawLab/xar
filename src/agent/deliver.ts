/**
 * Delivery system - sends streaming events back to xgw via IPC.
 *
 * Uses OutboundTarget (only in stream_start) + stream_id (all events) per ARCH.md.
 */

import type { OutboundTarget } from '../types.js'
import type { IpcConnection } from '../ipc/types.js'

export class Deliver {
  constructor(
    private conn: IpcConnection,
    private target: OutboundTarget,
  ) {}

  async streamStart(streamId: string): Promise<void> {
    await this.conn.send({ type: 'stream_start', stream_id: streamId, target: this.target })
  }

  async streamToken(streamId: string, token: string): Promise<void> {
    await this.conn.send({ type: 'stream_token', stream_id: streamId, token })
  }

  async streamThinking(streamId: string, delta: string): Promise<void> {
    await this.conn.send({ type: 'stream_thinking', stream_id: streamId, delta })
  }

  async streamToolCall(streamId: string, toolCall: unknown): Promise<void> {
    await this.conn.send({ type: 'stream_tool_call', stream_id: streamId, tool_call: toolCall })
  }

  async streamToolResult(streamId: string, toolResult: unknown): Promise<void> {
    await this.conn.send({ type: 'stream_tool_result', stream_id: streamId, tool_result: toolResult })
  }

  async streamEnd(streamId: string): Promise<void> {
    await this.conn.send({ type: 'stream_end', stream_id: streamId })
  }

  async streamError(streamId: string, error: string): Promise<void> {
    await this.conn.send({ type: 'stream_error', stream_id: streamId, error })
  }

  async streamCtxUsage(streamId: string, totalTokens: number, budgetTokens: number): Promise<void> {
    await this.conn.send({
      type: 'stream_ctx_usage',
      stream_id: streamId,
      ctx_usage: {
        total_tokens: totalTokens,
        budget_tokens: budgetTokens,
        pct: budgetTokens > 0 ? Math.round((totalTokens / budgetTokens) * 100) : 0,
      },
    })
  }

  async streamCompactStart(streamId: string, reason: 'threshold' | 'interval'): Promise<void> {
    await this.conn.send({ type: 'stream_compact_start', stream_id: streamId, compact_start: { reason } })
  }

  async streamCompactEnd(streamId: string, beforeTokens: number, afterTokens: number): Promise<void> {
    await this.conn.send({
      type: 'stream_compact_end',
      stream_id: streamId,
      compact_end: { before_tokens: beforeTokens, after_tokens: afterTokens },
    })
  }
}
