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
  // ── 入站消息 ──────────────────────────────────────────────────
  /** 向 agent 投递一条入站消息，触发其 run-loop 处理。
   *  发送方：xgw（外部 peer 消息）或 xar send CLI（agent-to-agent 内部消息）。
   *  daemon 收到后将消息 push 进目标 agent 的 queue。*/
  | 'inbound_message'

  // ── 出站流事件（xar → xgw，通过 stream_id 关联同一次 streaming）──
  /** 开始一次出站流，携带 OutboundTarget（channel_id / peer_id / conversation_id） */
  | 'stream_start'
  /** LLM 生成的文本 token，实时推送 */
  | 'stream_token'
  /** LLM 思考过程（reasoning model 的 thinking delta） */
  | 'stream_thinking'
  /** LLM 发起 tool call，携带 tool_call payload */
  | 'stream_tool_call'
  /** tool call 执行结果，携带 tool_result payload */
  | 'stream_tool_result'
  /** 流正常结束 */
  | 'stream_end'
  /** 流异常终止，携带 error 字段 */
  | 'stream_error'
  /** Context window 使用情况，携带 ctx_usage payload */
  | 'stream_ctx_usage'
  /** Session compact 开始（context 压缩），携带 compact_start payload */
  | 'stream_compact_start'
  /** Session compact 结束，携带 compact_end payload（before/after token 数） */
  | 'stream_compact_end'

  // ── Agent 生命周期管理（CLI → daemon via IPC）────────────────
  /** 启动指定 agent 的 run-loop */
  | 'agent_start'
  /** 停止指定 agent 的 run-loop */
  | 'agent_stop'
  /** 查询指定 agent 的运行时状态（queue depth、processing count 等） */
  | 'agent_status'
  /** 查询 daemon 整体状态（pid、uptime、所有运行中的 agent 列表） */
  | 'daemon_status'

  // ── 通用响应 ──────────────────────────────────────────────────
  /** 请求成功的响应，可携带 data 字段返回结果。
   *  daemon 在处理完 inbound_message / agent_start / agent_stop /
   *  agent_status / daemon_status 后，向请求方回复此消息。*/
  | 'ok'
  /** 请求失败的响应，携带 error 字段说明原因。
   *  场景：目标 agent 不存在、agent 未运行、消息格式错误等。
   *  stream_error 用于流式处理中途的错误，error 用于请求级别的失败。*/
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
