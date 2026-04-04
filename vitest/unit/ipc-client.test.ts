import { describe, it, expect, vi } from 'vitest'
import { CliError } from '../../src/types.js'

// ── Controllable WS mock ──────────────────────────────────────────────────────

type Handler = (...args: unknown[]) => void

class MockWS {
  static lastInstance: MockWS | null = null
  private handlers: Record<string, Handler[]> = {}

  constructor(_url: string) {
    MockWS.lastInstance = this
  }

  on(event: string, h: Handler) { (this.handlers[event] ??= []).push(h); return this }
  off(event: string, h: Handler) {
    this.handlers[event] = (this.handlers[event] ?? []).filter(x => x !== h)
    return this
  }
  emit(event: string, ...args: unknown[]) { for (const h of this.handlers[event] ?? []) h(...args) }
  send(_data: string, cb?: (err?: Error) => void) { cb?.() }
  close() {}
}

vi.mock('ws', () => ({ WebSocket: MockWS }))

const { IpcClient, sendIpcMessage } = await import('../../src/ipc/client.js')

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('IpcClient', () => {
  it('throws CliError when connection is refused', async () => {
    const client = new IpcClient(19999)
    const connectPromise = client.connect()
    // Synchronously emit error on the WS that was just created
    MockWS.lastInstance!.emit('error', new Error('ECONNREFUSED'))
    await expect(connectPromise).rejects.toBeInstanceOf(CliError)
  })

  it('resolves connect() when open fires', async () => {
    const client = new IpcClient(28213)
    const connectPromise = client.connect()
    MockWS.lastInstance!.emit('open')
    await expect(connectPromise).resolves.toBeUndefined()
    client.close()
  })
})

async function driveIpcMessage(response: unknown) {
  const responsePromise = sendIpcMessage({ type: 'agent_start', agent_id: 'test' }, 28213)
  const ws = MockWS.lastInstance!
  // Override send so it immediately emits the response after the message handler is registered
  ws.send = (_data: string, cb?: (err?: Error) => void) => {
    cb?.()
    ws.emit('message', Buffer.from(JSON.stringify(response)))
  }
  ws.emit('open')
  return responsePromise
}

describe('sendIpcMessage', () => {
  it('returns ok response when daemon responds', async () => {
    const result = await driveIpcMessage({ type: 'ok' })
    expect(result.type).toBe('ok')
  })

  it('returns error response when daemon responds with error', async () => {
    const result = await driveIpcMessage({ type: 'error', error: 'agent not found' })
    expect(result.type).toBe('error')
    expect(result.error).toBe('agent not found')
  })
})
