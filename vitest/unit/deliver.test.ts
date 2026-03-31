import { describe, it, expect, vi } from 'vitest'
import { Deliver } from '../../src/agent/deliver.js'
import type { IpcConnection } from '../../src/ipc/types.js'
import type { OutboundTarget } from '../../src/types.js'

function makeConn(): { conn: IpcConnection; sent: unknown[] } {
  const sent: unknown[] = []
  const conn: IpcConnection = {
    id: 'test-conn',
    send: vi.fn(async (msg) => { sent.push(msg) }),
    close: vi.fn(),
  }
  return { conn, sent }
}

const target: OutboundTarget = {
  channel_id: 'telegram:main',
  peer_id: 'alice',
  conversation_id: 'alice',
}

describe('Deliver', () => {
  it('streamStart sends stream_start with target and stream_id', async () => {
    const { conn, sent } = makeConn()
    const deliver = new Deliver(conn, target)
    await deliver.streamStart('telegram:main:alice:1')
    expect(sent).toHaveLength(1)
    expect((sent[0] as any).type).toBe('stream_start')
    expect((sent[0] as any).stream_id).toBe('telegram:main:alice:1')
    expect((sent[0] as any).target).toBe(target)
  })

  it('streamToken sends stream_token with token', async () => {
    const { conn, sent } = makeConn()
    const deliver = new Deliver(conn, target)
    await deliver.streamToken('s1', 'hello')
    expect((sent[0] as any).type).toBe('stream_token')
    expect((sent[0] as any).token).toBe('hello')
    expect((sent[0] as any).stream_id).toBe('s1')
  })

  it('streamThinking sends stream_thinking with delta', async () => {
    const { conn, sent } = makeConn()
    const deliver = new Deliver(conn, target)
    await deliver.streamThinking('s1', 'thinking...')
    expect((sent[0] as any).type).toBe('stream_thinking')
    expect((sent[0] as any).delta).toBe('thinking...')
  })

  it('streamEnd sends stream_end', async () => {
    const { conn, sent } = makeConn()
    const deliver = new Deliver(conn, target)
    await deliver.streamEnd('s1')
    expect((sent[0] as any).type).toBe('stream_end')
    expect((sent[0] as any).stream_id).toBe('s1')
  })

  it('streamError sends stream_error with error message', async () => {
    const { conn, sent } = makeConn()
    const deliver = new Deliver(conn, target)
    await deliver.streamError('s1', 'something went wrong')
    expect((sent[0] as any).type).toBe('stream_error')
    expect((sent[0] as any).error).toBe('something went wrong')
    expect((sent[0] as any).stream_id).toBe('s1')
  })

  it('each method sends exactly one message', async () => {
    const { conn, sent } = makeConn()
    const deliver = new Deliver(conn, target)
    await deliver.streamStart('s')
    await deliver.streamToken('s', 'tok')
    await deliver.streamThinking('s', 'delta')
    await deliver.streamEnd('s')
    await deliver.streamError('s', 'err')
    expect(sent).toHaveLength(5)
  })
})
