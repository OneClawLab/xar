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
  /** Event type for thread storage: 'message' triggers LLM, 'record' is context-only.
   *  Determined by xgw mention gating. Defaults to 'message' if omitted. */
  event_type?: 'message' | 'record'
  /**
   * Reply-back address: when set, the run-loop automatically delivers the
   * LLM text response to this target after the turn completes.
   *
   * Format mirrors send_message target: "agent:<agent_id>" or "peer:<peer_id>".
   * - "agent:xxx" → announce result to that agent (triggers its next LLM turn)
   * - "peer:xxx"  → deliver result directly to that peer via IPC (best-effort)
   *
   * Set by the orchestrator when dispatching a task via send_message(target='agent:...').
   * The auto-announce message does NOT carry reply_to, so the chain terminates
   * after one hop — preventing infinite ping-pong loops between agents.
   */
  reply_to?: string
  /**
   * Task context injected into the worker's system prompt.
   * Describes the worker's role and constraints for this specific task.
   * Set by the orchestrator when dispatching via send_message(target='agent:...').
   */
  task_context?: string
  /**
   * Whether the agent was mentioned in this message.
   * Passed through from xgw transparently; xar uses this (together with
   * routing.mode / routing.trigger) to decide the effective event_type.
   * Requirement 9.3
   */
  mentioned?: boolean
  /**
   * Conversation type from the originating channel (e.g. 'dm', 'group').
   * Passed through from xgw transparently so xar can apply mode-specific
   * routing logic without needing to re-parse the source address.
   * Requirement 9.3
   */
  conversation_type?: string
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

/**
 * IpcMessage — discriminated union keyed on `type`.
 *
 * Inbound (xgw/CLI → daemon):
 *   inbound_message, agent_start, agent_stop, agent_status, daemon_status
 *
 * Outbound stream events (daemon/xar → xgw, correlated by stream_id):
 *   stream_start, stream_token, stream_thinking, stream_tool_call,
 *   stream_tool_result, stream_end, stream_error, stream_ctx_usage,
 *   stream_compact_start, stream_compact_end
 *
 * Responses (daemon → CLI):
 *   ok, error
 */
export type IpcMessage =
  // ── 入站消息 ──────────────────────────────────────────────────
  /** 向 agent 投递一条入站消息，触发其 run-loop 处理。 */
  | { type: 'inbound_message'; agent_id: string; message: InboundMessage }

  // ── 出站流事件（xar → xgw）────────────────────────────────────
  /** 开始一次出站流，携带 OutboundTarget */
  | { type: 'stream_start'; stream_id: string; target: OutboundTarget }
  /** LLM 生成的文本 token */
  | { type: 'stream_token'; stream_id: string; token: string }
  /** LLM 思考过程（reasoning model 的 thinking delta） */
  | { type: 'stream_thinking'; stream_id: string; delta: string }
  /** LLM 发起 tool call */
  | { type: 'stream_tool_call'; stream_id: string; tool_call: unknown }
  /** tool call 执行结果 */
  | { type: 'stream_tool_result'; stream_id: string; tool_result: unknown }
  /** 流正常结束 */
  | { type: 'stream_end'; stream_id: string }
  /** 流异常终止 */
  | { type: 'stream_error'; stream_id: string; error: string }
  /** Context window 使用情况 */
  | { type: 'stream_ctx_usage'; stream_id: string; ctx_usage: CtxUsage }
  /** Session compact 开始 */
  | { type: 'stream_compact_start'; stream_id: string; compact_start: CompactStartInfo }
  /** Session compact 结束 */
  | { type: 'stream_compact_end'; stream_id: string; compact_end: CompactEndInfo }

  // ── Agent 生命周期管理（CLI → daemon via IPC）────────────────
  | { type: 'agent_start'; agent_id: string }
  | { type: 'agent_stop'; agent_id: string }
  | { type: 'agent_status'; agent_id: string }
  | { type: 'daemon_status' }

  // ── 通用响应 ──────────────────────────────────────────────────
  /** 请求成功，可携带 data 字段返回结果 */
  | { type: 'ok'; data?: unknown }
  /** 请求失败 */
  | { type: 'error'; error: string }

export class CliError extends Error {
  constructor(
    message: string,
    public exitCode: number = 1,
  ) {
    super(message)
    this.name = 'CliError'
  }
}

/**
 * Extends the pai Message type with the tool_calls field that LLM providers
 * return on assistant messages but pai's type doesn't expose directly.
 */
export type MessageWithToolCalls = import('pai').Message & {
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
}
