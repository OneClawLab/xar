import { describe, it, expect, vi } from 'vitest'
import { RunLoopImpl } from '../../src/agent/run-loop.js'
import { AsyncQueueImpl } from '../../src/agent/queue.js'
import type { InboundMessage } from '../../src/types.js'
import type { IpcConnection } from '../../src/ipc/types.js'

// RunLoopImpl.processMessage calls external services (pai, loadAgentConfig, etc.)
// so we test the lifecycle and error-isolation behaviour only.

function makeConn(): IpcConnection {
  return {
    id: 'conn1',
    send: vi.fn(async () => {}),
    close: vi.fn(),
  }
}

function makeMsg(content = 'hello'): InboundMessage {
  return {
    source: 'external:cli:default:dm:user1:user1',
    content,
  }
}

describe('RunLoopImpl', () => {
  it('stop() closes the queue and resolves start()', async () => {
    const queue = new AsyncQueueImpl<InboundMessage>()
    const conns = new Map([['c1', makeConn()]])
    const loop = new RunLoopImpl('agent1', queue, conns)

    const startPromise = loop.start()
    await loop.stop()
    await expect(startPromise).resolves.toBeUndefined()
  })

  it('start() resolves immediately when queue is already closed', async () => {
    const queue = new AsyncQueueImpl<InboundMessage>()
    queue.close()
    const conns = new Map([['c1', makeConn()]])
    const loop = new RunLoopImpl('agent1', queue, conns)
    await expect(loop.start()).resolves.toBeUndefined()
  })

  it('stop() is idempotent — calling twice does not throw', async () => {
    const queue = new AsyncQueueImpl<InboundMessage>()
    const conns = new Map([['c1', makeConn()]])
    const loop = new RunLoopImpl('agent1', queue, conns)
    const startPromise = loop.start()
    await loop.stop()
    await expect(loop.stop()).resolves.toBeUndefined()
    await startPromise
  })
})
