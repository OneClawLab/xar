import { describe, it, expect, vi } from 'vitest'
import { Deliver } from '../../src/agent/deliver.js'
import type { IpcConnection } from '../../src/ipc/types.js'
import type { ReplyContext } from '../../src/types.js'

function makeConn(): { conn: IpcConnection; sent: unknown[] } {
  const sent: unknown[] = []
  const conn: IpcConnection = {
    id: 'test-conn',
    send: vi.fn(async (msg) => { sent.push(msg) }),
    close: vi.fn(),
  }
  return { conn, sent }
}

const replyCtx: ReplyContext = {
  channel_type: 'internal',
  channel_id: 'ch1',
  session_type: 'dm',
  session_id: 'sess1',
  peer_id: 'peer1',
}

describe('Deliver', () => {
  it('streamStart sends stream_start with reply_context and session_id', async () => {
    const { conn, sent } = makeConn()
    const deliver = new Deliver(conn, replyCtx)
    await deliver.streamStart('sess-abc')
    expect(sent).toHaveLength(1)
    expect((sent[0] as any).type).toBe('stream_start')
    expect((sent[0] as any).session_id).toBe('sess-abc')
    expect((sent[0] as any).reply_context).toBe(replyCtx)
  })

  it('streamToken sends stream_token with token', async () => {
    const { conn, sent } = makeConn()
    const deliver = new Deliver(conn, replyCtx)
    await deliver.streamToken('sess-abc', 'hello')
    expect((sent[0] as any).type).toBe('stream_token')
    expect((sent[0] as any).token).toBe('hello')
    expect((sent[0] as any).session_id).toBe('sess-abc')
  })

  it('streamThinking sends stream_thinking with delta', async () => {
    const { conn, sent } = makeConn()
    const deliver = new Deliver(conn, replyCtx)
    await deliver.streamThinking('sess-abc', 'thinking...')
    expect((sent[0] as any).type).toBe('stream_thinking')
    expect((sent[0] as any).delta).toBe('thinking...')
  })

  it('streamEnd sends stream_end', async () => {
    const { conn, sent } = makeConn()
    const deliver = new Deliver(conn, replyCtx)
    await deliver.streamEnd('sess-abc')
    expect((sent[0] as any).type).toBe('stream_end')
    expect((sent[0] as any).session_id).toBe('sess-abc')
  })

  it('streamError sends stream_error with error message', async () => {
    const { conn, sent } = makeConn()
    const deliver = new Deliver(conn, replyCtx)
    await deliver.streamError('sess-abc', 'something went wrong')
    expect((sent[0] as any).type).toBe('stream_error')
    expect((sent[0] as any).error).toBe('something went wrong')
    expect((sent[0] as any).session_id).toBe('sess-abc')
  })

  it('each method sends exactly one message', async () => {
    const { conn, sent } = makeConn()
    const deliver = new Deliver(conn, replyCtx)
    await deliver.streamStart('s')
    await deliver.streamToken('s', 'tok')
    await deliver.streamThinking('s', 'delta')
    await deliver.streamEnd('s')
    await deliver.streamError('s', 'err')
    expect(sent).toHaveLength(5)
  })
})
