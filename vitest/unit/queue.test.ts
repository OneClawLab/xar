/**
 * Unit tests for AsyncQueue
 */

import { describe, it, expect } from 'vitest'
import { AsyncQueueImpl } from '../../src/agent/queue.js'

describe('AsyncQueue', () => {
  it('should push and consume items in FIFO order', async () => {
    const queue = new AsyncQueueImpl<number>()
    const results: number[] = []

    queue.push(1)
    queue.push(2)
    queue.push(3)
    queue.close()

    for await (const item of queue) {
      results.push(item)
    }

    expect(results).toEqual([1, 2, 3])
  })

  it('should handle async iteration with delayed pushes', async () => {
    const queue = new AsyncQueueImpl<string>()
    const results: string[] = []

    const consumePromise = (async () => {
      for await (const item of queue) {
        results.push(item)
      }
    })()

    // Push items with delays
    await new Promise((resolve) => setTimeout(resolve, 10))
    queue.push('a')

    await new Promise((resolve) => setTimeout(resolve, 10))
    queue.push('b')

    await new Promise((resolve) => setTimeout(resolve, 10))
    queue.push('c')

    queue.close()

    await consumePromise

    expect(results).toEqual(['a', 'b', 'c'])
  })

  it('should stop iteration when closed', async () => {
    const queue = new AsyncQueueImpl<number>()
    const results: number[] = []

    queue.push(1)
    queue.push(2)
    queue.close()
    queue.push(3) // Should be ignored

    for await (const item of queue) {
      results.push(item)
    }

    expect(results).toEqual([1, 2])
  })

  it('should handle sequential iteration', async () => {
    const queue = new AsyncQueueImpl<number>()
    const results1: number[] = []
    const results2: number[] = []

    queue.push(1)
    queue.push(2)
    queue.push(3)
    queue.close()

    // First consumer gets all items
    for await (const item of queue) {
      results1.push(item)
    }

    // Second consumer gets nothing (queue already consumed)
    for await (const item of queue) {
      results2.push(item)
    }

    expect(results1).toEqual([1, 2, 3])
    expect(results2).toEqual([])
  })

  it('should handle empty queue', async () => {
    const queue = new AsyncQueueImpl<number>()
    const results: number[] = []

    queue.close()

    for await (const item of queue) {
      results.push(item)
    }

    expect(results).toEqual([])
  })
})
