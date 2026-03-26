/**
 * Property-based tests for AsyncQueue FIFO ordering
 * Validates: Requirements 5.2, 5.3
 */

import { describe, it } from 'vitest'
import fc from 'fast-check'
import { AsyncQueueImpl } from '../../src/agent/queue.js'

describe('AsyncQueue FIFO Property Tests', () => {
  it('Property 1: Message Queue FIFO Ordering - For any sequence of messages pushed to an agent queue, consuming them via async iteration SHALL return them in the same order they were pushed', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer()), async (messages) => {
        const queue = new AsyncQueueImpl<number>()
        const results: number[] = []

        // Push all messages
        for (const msg of messages) {
          queue.push(msg)
        }
        queue.close()

        // Consume all messages
        for await (const msg of queue) {
          results.push(msg)
        }

        // Verify FIFO order
        if (messages.length > 0) {
          return JSON.stringify(results) === JSON.stringify(messages)
        }
        return true
      }),
      { numRuns: 100 },
    )
  })

  it('Property 1: FIFO with string messages', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.string()), async (messages) => {
        const queue = new AsyncQueueImpl<string>()
        const results: string[] = []

        for (const msg of messages) {
          queue.push(msg)
        }
        queue.close()

        for await (const msg of queue) {
          results.push(msg)
        }

        return JSON.stringify(results) === JSON.stringify(messages)
      }),
      { numRuns: 100 },
    )
  })

  it('Property 1: FIFO with object messages', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            id: fc.integer(),
            content: fc.string(),
          }),
        ),
        async (messages) => {
          const queue = new AsyncQueueImpl<{ id: number; content: string }>()
          const results: { id: number; content: string }[] = []

          for (const msg of messages) {
            queue.push(msg)
          }
          queue.close()

          for await (const msg of queue) {
            results.push(msg)
          }

          return JSON.stringify(results) === JSON.stringify(messages)
        },
      ),
      { numRuns: 100 },
    )
  })
})
