/**
 * Agent-specific types
 */

export interface AgentConfig {
  agent_id: string
  kind: 'system' | 'user'
  pai: {
    provider: string
    model: string
  }
  routing: {
    default: 'per-peer' | 'per-conversation' | 'per-agent'
  }
  memory: {
    compact_threshold_tokens: number
    session_compact_threshold_tokens: number
  }
  retry: {
    max_attempts: number
  }
}

export interface ThreadEvent {
  id: number
  source: string
  type: 'message' | 'record'
  subtype?: string
  content: string
  timestamp: number
}

export interface ThreadEventInput {
  source: string
  type: 'message' | 'record'
  subtype?: string
  content: string
}

export interface PeekOptions {
  lastEventId: number
  limit?: number
  filter?: string
}

export interface ThreadStore {
  push(event: ThreadEventInput): Promise<ThreadEvent>
  pushBatch(events: ThreadEventInput[]): Promise<ThreadEvent[]>
  peek(opts: PeekOptions): Promise<ThreadEvent[]>
}

export interface ThreadLib {
  open(threadPath: string): Promise<ThreadStore>
  init(threadPath: string): Promise<ThreadStore>
  exists(threadPath: string): Promise<boolean>
  destroy(threadPath: string): Promise<void>
}
