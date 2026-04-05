/**
 * Property-based tests for the Context module.
 * Feature: communication-refactor
 */

import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { detectRole, buildCommunicationContext } from '../../src/agent/context.js'
import type { TaskSummaryContext } from '../../src/agent/context.js'
import type { AgentConfig } from '../../src/agent/types.js'
import type { InboundMessage } from '../../src/types.js'

// ── Generators ───────────────────────────────────────────────────────────────

const genId = fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/)

/** External DM source: external:<ch_type>:<ch_instance>:dm:<conv_id>:<peer_id> */
const genExternalDmSource = fc.tuple(genId, genId, genId, genId).map(
  ([chType, chInst, convId, peerId]) => `external:${chType}:${chInst}:dm:${convId}:${peerId}`,
)

/** External group source */
const genExternalGroupSource = fc.tuple(genId, genId, genId, genId).map(
  ([chType, chInst, convId, peerId]) => `external:${chType}:${chInst}:group:${convId}:${peerId}`,
)

/** Any external source */
const genExternalSource = fc.oneof(genExternalDmSource, genExternalGroupSource)

/** Internal source: internal:<conv_type>:<conv_id>:<sender> */
const genInternalSource = fc.tuple(genId, genId, genId).map(
  ([convType, convId, sender]) => `internal:${convType}:${convId}:${sender}`,
)

const genReactiveConfig = (): fc.Arbitrary<AgentConfig> =>
  fc.record({
    agent_id: genId,
    kind: fc.constantFrom('system' as const, 'user' as const),
    pai: fc.record({ provider: genId, model: genId }),
    routing: fc.constant({ mode: 'reactive' as const, trigger: 'mention' as const }),
    memory: fc.record({
      compact_threshold_tokens: fc.integer({ min: 1000, max: 100000 }),
      session_compact_threshold_tokens: fc.integer({ min: 500, max: 50000 }),
    }),
    retry: fc.record({ max_attempts: fc.integer({ min: 1, max: 10 }) }),
  })

const genAutonomousConfig = (): fc.Arbitrary<AgentConfig> =>
  fc.record({
    agent_id: genId,
    kind: fc.constantFrom('system' as const, 'user' as const),
    pai: fc.record({ provider: genId, model: genId }),
    routing: fc.constant({ mode: 'autonomous' as const, trigger: 'all' as const }),
    memory: fc.record({
      compact_threshold_tokens: fc.integer({ min: 1000, max: 100000 }),
      session_compact_threshold_tokens: fc.integer({ min: 500, max: 50000 }),
    }),
    retry: fc.record({ max_attempts: fc.integer({ min: 1, max: 10 }) }),
  })

const genAnyConfig = (): fc.Arbitrary<AgentConfig> =>
  fc.oneof(genReactiveConfig(), genAutonomousConfig())

/** Build an InboundMessage with a given source and optional reply_to */
function makeMsg(source: string, reply_to?: string): InboundMessage {
  return { source, content: 'test content', ...(reply_to !== undefined ? { reply_to } : {}) }
}

// ── Property 7: 角色检测正确性 ────────────────────────────────────────────────
// Feature: communication-refactor, Property 7: 角色检测正确性
// Validates: Requirements 5.1, 5.2, 5.3, 5.4

describe('Property 7: 角色检测正确性', () => {
  it('external source + hasPendingTasks=true → orchestrator-waiting', () => {
    fc.assert(
      fc.property(
        genAnyConfig(),
        genExternalSource,
        fc.option(genId, { nil: undefined }).map(id => id ? `peer:${id}` : undefined),
        (config, source, reply_to) => {
          const msg = makeMsg(source, reply_to)
          const taskCtx: TaskSummaryContext = { hasPendingTasks: true, isSummaryTurn: false }
          const role = detectRole(msg, config, taskCtx)
          expect(role).toBe('orchestrator-waiting')
        },
      ),
      { numRuns: 200 },
    )
  })

  it('external source + no pending tasks + reactive → front-reactive', () => {
    fc.assert(
      fc.property(
        genReactiveConfig(),
        genExternalSource,
        (config, source) => {
          const msg = makeMsg(source)
          const taskCtx: TaskSummaryContext = { hasPendingTasks: false, isSummaryTurn: false }
          const role = detectRole(msg, config, taskCtx)
          expect(role).toBe('front-reactive')
        },
      ),
      { numRuns: 200 },
    )
  })

  it('external source + no pending tasks + autonomous → front-autonomous', () => {
    fc.assert(
      fc.property(
        genAutonomousConfig(),
        genExternalSource,
        (config, source) => {
          const msg = makeMsg(source)
          const taskCtx: TaskSummaryContext = { hasPendingTasks: false, isSummaryTurn: false }
          const role = detectRole(msg, config, taskCtx)
          expect(role).toBe('front-autonomous')
        },
      ),
      { numRuns: 200 },
    )
  })

  it('internal source + isSummaryTurn=true + has reply_to → worker-synthesizing', () => {
    fc.assert(
      fc.property(
        genAnyConfig(),
        genInternalSource,
        genId.map(id => `agent:${id}`),
        (config, source, reply_to) => {
          const msg = makeMsg(source, reply_to)
          const taskCtx: TaskSummaryContext = { hasPendingTasks: false, isSummaryTurn: true }
          const role = detectRole(msg, config, taskCtx)
          expect(role).toBe('worker-synthesizing')
        },
      ),
      { numRuns: 200 },
    )
  })

  it('internal source + isSummaryTurn=true + no reply_to → orchestrator-synthesizing', () => {
    fc.assert(
      fc.property(
        genAnyConfig(),
        genInternalSource,
        (config, source) => {
          const msg = makeMsg(source) // no reply_to
          const taskCtx: TaskSummaryContext = { hasPendingTasks: false, isSummaryTurn: true }
          const role = detectRole(msg, config, taskCtx)
          expect(role).toBe('orchestrator-synthesizing')
        },
      ),
      { numRuns: 200 },
    )
  })

  it('internal source + isSummaryTurn=false + has reply_to → worker', () => {
    fc.assert(
      fc.property(
        genAnyConfig(),
        genInternalSource,
        genId.map(id => `agent:${id}`),
        (config, source, reply_to) => {
          const msg = makeMsg(source, reply_to)
          const taskCtx: TaskSummaryContext = { hasPendingTasks: false, isSummaryTurn: false }
          const role = detectRole(msg, config, taskCtx)
          expect(role).toBe('worker')
        },
      ),
      { numRuns: 200 },
    )
  })

  it('internal source + isSummaryTurn=false + no reply_to → participant', () => {
    fc.assert(
      fc.property(
        genAnyConfig(),
        genInternalSource,
        (config, source) => {
          const msg = makeMsg(source) // no reply_to
          const taskCtx: TaskSummaryContext = { hasPendingTasks: false, isSummaryTurn: false }
          const role = detectRole(msg, config, taskCtx)
          expect(role).toBe('participant')
        },
      ),
      { numRuns: 200 },
    )
  })
})

// ── Property 8: Communication Context 生成正确性 ─────────────────────────────
// Feature: communication-refactor, Property 8: Communication Context 生成正确性
// Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7

/** Minimal threadStore mock that returns an empty event list */
const mockThreadStore = {
  peek: async () => [],
} as any

describe('Property 8: Communication Context 生成正确性', () => {
  it('all contexts: first line after ## Communication Context contains You are: agent:<agentId>', async () => {
    await fc.assert(
      fc.asyncProperty(
        genAnyConfig(),
        genExternalSource,
        async (config, source) => {
          const msg = makeMsg(source)
          const ctx = await buildCommunicationContext(
            config.agent_id, msg, config, mockThreadStore, [], undefined,
          )
          const lines = ctx.split('\n')
          const headerIdx = lines.findIndex(l => l === '## Communication Context')
          expect(headerIdx).toBeGreaterThanOrEqual(0)
          // The line immediately after the header should contain the identity anchor
          const identityLine = lines[headerIdx + 1]
          expect(identityLine).toContain(`You are: agent:${config.agent_id}`)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('worker role: context contains DO NOT use send_message to reply', async () => {
    await fc.assert(
      fc.asyncProperty(
        genAnyConfig(),
        genInternalSource,
        genId.map(id => `agent:${id}`),
        async (config, source, reply_to) => {
          const msg = makeMsg(source, reply_to)
          // non-summary turn → worker role
          const taskCtx: TaskSummaryContext = { hasPendingTasks: false, isSummaryTurn: false }
          const ctx = await buildCommunicationContext(
            config.agent_id, msg, config, mockThreadStore, [], taskCtx,
          )
          expect(ctx).toContain('DO NOT use send_message to reply')
        },
      ),
      { numRuns: 100 },
    )
  })

  it('autonomous role: context contains You decide whether to respond', async () => {
    await fc.assert(
      fc.asyncProperty(
        genAutonomousConfig(),
        genExternalSource,
        async (config, source) => {
          const msg = makeMsg(source)
          const taskCtx: TaskSummaryContext = { hasPendingTasks: false, isSummaryTurn: false }
          const ctx = await buildCommunicationContext(
            config.agent_id, msg, config, mockThreadStore, [], taskCtx,
          )
          expect(ctx).toContain('You decide whether to respond')
        },
      ),
      { numRuns: 100 },
    )
  })

  it('orchestrator-synthesizing role: context contains all subtask results', async () => {
    await fc.assert(
      fc.asyncProperty(
        genAnyConfig(),
        genInternalSource,
        fc.array(
          fc.record({
            worker: genId,
            instruction: fc.string({ minLength: 1, maxLength: 40 }),
            result: fc.string({ minLength: 1, maxLength: 40 }),
            status: fc.constant('done' as const),
          }),
          { minLength: 1, maxLength: 4 },
        ),
        async (config, source, subtaskResults) => {
          const msg = makeMsg(source) // no reply_to → orchestrator-synthesizing
          const taskCtx: TaskSummaryContext = {
            hasPendingTasks: false,
            isSummaryTurn: true,
            subtaskResults,
          }
          const ctx = await buildCommunicationContext(
            config.agent_id, msg, config, mockThreadStore, [], taskCtx,
          )
          for (const st of subtaskResults) {
            expect(ctx).toContain(st.result)
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('all contexts end with the receive_user_update explanation', async () => {
    await fc.assert(
      fc.asyncProperty(
        genAnyConfig(),
        fc.oneof(genExternalSource, genInternalSource),
        async (config, source) => {
          const msg = makeMsg(source)
          const ctx = await buildCommunicationContext(
            config.agent_id, msg, config, mockThreadStore, [], undefined,
          )
          expect(ctx).toContain('receive_user_update')
        },
      ),
      { numRuns: 100 },
    )
  })
})
