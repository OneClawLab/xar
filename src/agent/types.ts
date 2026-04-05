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
    mode: 'reactive' | 'autonomous'
    trigger: 'mention' | 'all'
    override?: Record<string, string>
  }
  memory: {
    compact_threshold_tokens: number
    session_compact_threshold_tokens: number
  }
  retry: {
    max_attempts: number
  }
}

// Thread types are imported from the 'thread' package — do not duplicate here.
// See: thread/src/lib/types.ts for ThreadEvent, ThreadEventInput, PeekOptions, ThreadStore.
