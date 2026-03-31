/**
 * Property-based tests for run-loop error recovery.
 * Verifies that the run-loop continues processing after errors,
 * using the actual AsyncQueue consumed by a for-await loop with
 * per-message error isolation (matching RunLoopImpl's pattern).
 */

import { describe, it } from 'vitest'
import fc from 'fast-check'
import { AsyncQueueImpl } from '../../src/agent/queue.js'
import type { InboundMessage } from '../../src/types.js'

/**
 * Simulate the run-loop's error-isolation pattern:
 * for-await over queue, try/catch per message, never break on error.
 */
async function simulateRunLoop(
  queue: AsyncQueueImpl<InboundMessage>,
  shouldFail: (msg: InboundMessage) => boolean,
): Promise<{ processed: string[]; errors: string[] }> {
  const processed: string[] = []
  const errors: string[] = []

  for await (const msg of queue) {
    try {
      if (shouldFail(msg)) {
        throw new Error(`fail:${msg.source}`)
      }
      processed.push(msg.source)
    } catch {
      errors.push(msg.source)
    }
  }

  return { processed, errors }
}

function makeMsg(source: string): InboundMessage {
  return { source: `external:tui:default:dm:${source}:${source}`, content: 'hi' }
}

describe('Run-loop Error Recovery', () => {
  it('Property: all messages are consumed regardless of per-message errors', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(
          fc.stringMatching(/^[a-z][a-z0-9]{0,9}$/),
          fc.boolean(),
        ), { minLength: 1, maxLength: 30 }),
        async (items) => {
          const queue = new AsyncQueueImpl<InboundMessage>()
          const failSet = new Set(items.filter(([, fail]) => fail).map(([id]) => id))

          for (const [id] of items) {
            queue.push(makeMsg(id))
          }
          queue.close()

          const { processed, errors } = await simulateRunLoop(
            queue,
            (msg) => failSet.has(msg.source.split(':')[4]!),
          )

          return processed.length + errors.length === items.length
        },
      ),
      { numRuns: 100 },
    )
  })

  it('Property: message processing order is preserved despite errors', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(
          fc.stringMatching(/^[a-z][a-z0-9]{0,9}$/),
          fc.boolean(),
        ), { minLength: 1, maxLength: 30 }),
        async (items) => {
          const queue = new AsyncQueueImpl<InboundMessage>()
          const failSet = new Set(items.filter(([, fail]) => fail).map(([id]) => id))

          for (const [id] of items) {
            queue.push(makeMsg(id))
          }
          queue.close()

          const { processed, errors } = await simulateRunLoop(
            queue,
            (msg) => failSet.has(msg.source.split(':')[4]!),
          )

          // Merge back in order and verify it matches input order
          const allInOrder: string[] = []
          let pi = 0, ei = 0
          for (const [id, fail] of items) {
            const src = `external:tui:default:dm:${id}:${id}`
            if (failSet.has(id)) {
              if (errors[ei] !== src) return false
              ei++
            } else {
              if (processed[pi] !== src) return false
              pi++
            }
            allInOrder.push(src)
          }
          return true
        },
      ),
      { numRuns: 100 },
    )
  })
})
