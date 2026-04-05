/**
 * Unit tests for agent configuration
 */

import { describe, it, expect } from 'vitest'
import { validateConfig } from '../../src/agent/config.js'
import { CliError } from '../../src/types.js'
import { AgentConfig } from '../../src/agent/types.js'

describe('Agent Configuration', () => {
  const validConfig: AgentConfig = {
    agent_id: 'test-agent',
    kind: 'user',
    pai: {
      provider: 'openai',
      model: 'gpt-4o',
    },
    routing: {
      mode: 'reactive',
      trigger: 'mention',
    },
    memory: {
      compact_threshold_tokens: 8000,
      session_compact_threshold_tokens: 4000,
    },
    retry: {
      max_attempts: 3,
    },
  }

  it('should validate correct config', () => {
    expect(() => validateConfig(validConfig)).not.toThrow()
  })

  it('should reject missing agent_id', () => {
    const config = { ...validConfig, agent_id: '' }
    expect(() => validateConfig(config)).toThrow(CliError)
  })

  it('should reject invalid kind', () => {
    const config = { ...validConfig, kind: 'invalid' as any }
    expect(() => validateConfig(config)).toThrow(CliError)
  })

  it('should reject missing pai provider', () => {
    const config = {
      ...validConfig,
      pai: { ...validConfig.pai, provider: '' },
    }
    expect(() => validateConfig(config)).toThrow(CliError)
  })

  it('should reject invalid routing mode', () => {
    const config = {
      ...validConfig,
      routing: { mode: 'invalid' as any, trigger: 'mention' as const },
    }
    expect(() => validateConfig(config)).toThrow(CliError)
  })

  it('should reject missing memory thresholds', () => {
    const config = {
      ...validConfig,
      memory: { compact_threshold_tokens: 8000 } as any,
    }
    expect(() => validateConfig(config)).toThrow(CliError)
  })

  it('should reject missing retry max_attempts', () => {
    const config = {
      ...validConfig,
      retry: {} as any,
    }
    expect(() => validateConfig(config)).toThrow(CliError)
  })
})
