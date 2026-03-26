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
  | 'stream_end'
  | 'stream_error'
  | 'agent_start'
  | 'agent_stop'
  | 'agent_status'
  | 'daemon_status'
  | 'ok'
  | 'error'

export interface IpcMessage {
  type: IpcMessageType
  agent_id?: string
  message?: InboundMessage
  reply_context?: ReplyContext
  session_id?: string
  token?: string
  delta?: string
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
