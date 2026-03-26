/**
 * Property-based tests for configuration validation
 * Validates: Requirements 17.2, 17.4
 */

import { describe, it } from 'vitest'
import fc from 'fast-check'
import { validateConfig } from '../../src/agent/config.js'
import { CliError } from '../../src/types.js'
import { AgentConfig } from '../../src/agent/types.js'

describe('Configuration Validation Property Tests', () => {
  const validConfigArb = fc.record({
    agent_id: fc.string({ minLength: 1 }),
    kind: fc.oneof(fc.constant('system'), fc.constant('user')),
    pai: fc.record({
      provider: fc.string({ minLength: 1 }),
      model: fc.string({ minLength: 1 }),
    }),
    routing: fc.record({
      default: fc.oneof(
        fc.constant('per-peer'),
        fc.constant('per-session'),
        fc.constant('per-agent'),
      ),
    }),
    memory: fc.record({
      compact_threshold_tokens: fc.integer({ min: 1 }),
      session_compact_threshold_tokens: fc.integer({ min: 1 }),
    }),
    retry: fc.record({
      max_attempts: fc.integer({ min: 1 }),
    }),
  })

  it('Property 14: Configuration Validation - For any agent configuration loaded from config.json, the Daemon SHALL validate that all required fields are present and have valid types', () => {
    fc.assert(
      fc.property(validConfigArb, (config) => {
        // Valid configs should not throw
        try {
          validateConfig(config as AgentConfig)
          return true
        } catch (err) {
          return false
        }
      }),
      { numRuns: 100 },
    )
  })

  it('Property 14: Invalid configs should throw CliError', () => {
    fc.assert(
      fc.property(
        fc.record({
          agent_id: fc.oneof(fc.constant(''), fc.constant(null as any)),
          kind: fc.string(),
          pai: fc.record({
            provider: fc.string(),
            model: fc.string(),
          }),
          routing: fc.record({
            default: fc.string(),
          }),
          memory: fc.record({
            compact_threshold_tokens: fc.integer(),
            session_compact_threshold_tokens: fc.integer(),
          }),
          retry: fc.record({
            max_attempts: fc.integer(),
          }),
        }),
        (config) => {
          try {
            validateConfig(config as AgentConfig)
            // If agent_id is empty or null, should have thrown
            return config.agent_id !== '' && config.agent_id !== null
          } catch (err) {
            return err instanceof CliError
          }
        },
      ),
      { numRuns: 50 },
    )
  })
})
