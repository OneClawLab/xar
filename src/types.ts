/**
 * IPC Message Types and Interfaces
 */

/**
 * Inbound message from xgw → xar.
 * Only source + content; outbound routing info is derived from source at reply time.
 */
export interface InboundMessage {
  source: string
  content: string
}

/**
 * Outbound target address for stream_start events.
 * xgw uses channel_id to find the plugin, peer_id + conversation_id for delivery.
 */
export interface OutboundTarget {
  channel_id: string
  peer_id: string
  conversation_id: string
}

export type IpcMessageType =
  | 'inbound_message'
  | 'stream_start'
  | 'stream_token'
  | 'stream_thinking'
  | 'stream_tool_call'
  | 'stream_tool_result'
  | 'stream_end'
  | 'stream_error'
  | 'stream_ctx_usage'
  | 'stream_compact_start'
  | 'stream_compact_end'
  | 'agent_start'
  | 'agent_stop'
  | 'agent_status'
  | 'daemon_status'
  | 'ok'
  | 'error'

export interface CtxUsage {
  total_tokens: number
  budget_tokens: number
  pct: number
}

export interface CompactStartInfo {
  reason: 'threshold' | 'interval'
}

export interface CompactEndInfo {
  before_tokens: number
  after_tokens: number
}

export interface IpcMessage {
  type: IpcMessageType
  agent_id?: string
  message?: InboundMessage
  /** stream_id correlates all events within a single streaming session */
  stream_id?: string
  /** OutboundTarget — only present in stream_start */
  target?: OutboundTarget
  token?: string
  delta?: string
  /** tool_call event payload (JSON-encoded) */
  tool_call?: unknown
  /** tool_result event payload (JSON-encoded) */
  tool_result?: unknown
  /** ctx_usage payload */
  ctx_usage?: CtxUsage
  /** compact_start payload */
  compact_start?: CompactStartInfo
  /** compact_end payload */
  compact_end?: CompactEndInfo
  data?: unknown
  error?: string
}

export class CliError extends Error {
  constructor(
    message: string,
    public exitCode: number = 1,
  ) {
    super(message)
    this.name = 'CliError'
  }
}
