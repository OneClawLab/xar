/**
 * Property-based tests for AsyncQueue FIFO ordering
 */

import { describe, it } from 'vitest'
import fc from 'fast-check'
import { AsyncQueueImpl } from '../../src/agent/queue.js'

describe('AsyncQueue FIFO Property Tests', () => {
  it('Property: For any sequence of values, consuming the queue SHALL return them in push order', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.oneof(fc.integer(), fc.string(), fc.record({ id: fc.integer(), content: fc.string() }))),
        async (messages) => {
          const queue = new AsyncQueueImpl<unknown>()
          const results: unknown[] = []

          for (const msg of messages) queue.push(msg)
          queue.close()

          for await (const msg of queue) results.push(msg)

          return JSON.stringify(results) === JSON.stringify(messages)
        },
      ),
      { numRuns: 100 },
    )
  })
})
