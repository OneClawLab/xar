/**
 * IPC Message Types and Interfaces
 */

export interface InboundMessage {
  source: string
  content: string
  reply_context: ReplyContext
}

export interface ReplyContext {
  channel_type: string
  channel_id: string
  session_type: string
  session_id: string
  peer_id: string
  ipc_conn_id?: string
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
  reply_context?: ReplyContext
  session_id?: string
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
