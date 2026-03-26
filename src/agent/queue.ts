/**
 * AsyncQueue - Per-agent in-memory message buffer
 * Implements FIFO queue with async iteration support
 */

export interface AsyncQueue<T> {
  push(item: T): void
  close(): void
  size(): number
  [Symbol.asyncIterator](): AsyncIterator<T>
}

export class AsyncQueueImpl<T> implements AsyncQueue<T> {
  private items: T[] = []
  private waiters: ((item: T | null) => void)[] = []
  private closed = false

  push(item: T): void {
    if (this.closed) return

    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift()
      if (waiter) {
        waiter(item)
      }
    } else {
      this.items.push(item)
    }
  }

  size(): number {
    return this.items.length
  }

  close(): void {
    this.closed = true
    this.waiters.forEach((w) => w(null))
    this.waiters = []
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (!this.closed || this.items.length > 0) {
      if (this.items.length > 0) {
        const item = this.items.shift()
        if (item !== undefined) {
          yield item
        }
      } else if (!this.closed) {
        const item = await new Promise<T | null>((resolve) => {
          this.waiters.push((item) => resolve(item))
        })
        if (item !== null) {
          yield item
        }
      }
    }
  }
}
