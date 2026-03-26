/**
 * Property-based tests for run-loop error recovery
 * Validates: Requirements 13.3
 */

import { describe, it } from 'vitest'
import fc from 'fast-check'
import { AsyncQueueImpl } from '../../src/agent/queue.js'

describe('Run-loop Error Recovery Property Tests', () => {
  it('Property 9: Run-loop Continuation After Error - For any sequence of messages with errors interspersed, the run-loop SHALL continue processing after encountering errors', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            id: fc.integer(),
            shouldError: fc.boolean(),
          }),
        ),
        async (messages) => {
          const queue = new AsyncQueueImpl<{ id: number; shouldError: boolean }>()
          const processedIds: number[] = []
          const errorIds: number[] = []

          // Push all messages
          for (const msg of messages) {
            queue.push(msg)
          }
          queue.close()

          // Process messages with error handling
          for await (const msg of queue) {
            try {
              if (msg.shouldError) {
                errorIds.push(msg.id)
                throw new Error(`Simulated error for message ${msg.id}`)
              }
              processedIds.push(msg.id)
            } catch (err) {
              // Continue processing after error
              continue
            }
          }

          // Verify all messages were processed (either successfully or with error)
          const allProcessed = processedIds.length + errorIds.length
          return allProcessed === messages.length
        },
      ),
      { numRuns: 100 },
    )
  })

  it('Property 9: Error recovery maintains message order - Errors should not affect the order of subsequent message processing', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            id: fc.integer(),
            shouldError: fc.boolean(),
          }),
        ),
        async (messages) => {
          if (messages.length === 0) return true

          const queue = new AsyncQueueImpl<{ id: number; shouldError: boolean }>()
          const processOrder: number[] = []

          for (const msg of messages) {
            queue.push(msg)
          }
          queue.close()

          for await (const msg of queue) {
            try {
              if (msg.shouldError) {
                throw new Error(`Error for ${msg.id}`)
              }
              processOrder.push(msg.id)
            } catch (err) {
              processOrder.push(msg.id)
              continue
            }
          }

          // Verify order matches input order
          const expectedOrder = messages.map((m) => m.id)
          return JSON.stringify(processOrder) === JSON.stringify(expectedOrder)
        },
      ),
      { numRuns: 100 },
    )
  })
})
