/**
 * Unit tests for IpcChunkWriter (src/daemon/ipc-chunk-writer.ts)
 */

import { describe, it, expect, vi } from 'vitest'
import { IpcChunkWriter } from '../../src/daemon/ipc-chunk-writer.js'
import type { IpcConnection } from '../../src/ipc/types.js'

function makeConn(): { conn: IpcConnection; sent: unknown[] } {
  const sent: unknown[] = []
  return {
    conn: {
      id: 'test',
      send: vi.fn(async (msg) => { sent.push(msg) }),
      close: vi.fn(),
    },
    sent,
  }
}

describe('IpcChunkWriter', () => {
  it('sends stream_token with correct stream_id on write', async () => {
    const { conn, sent } = makeConn()
    const writer = new IpcChunkWriter(conn, 'telegram:main:alice:1')

    await new Promise<void>((resolve, reject) => {
      writer.write('hello', (err) => err ? reject(err) : resolve())
    })

    expect(sent).toHaveLength(1)
    expect((sent[0] as any).type).toBe('stream_token')
    expect((sent[0] as any).stream_id).toBe('telegram:main:alice:1')
    expect((sent[0] as any).token).toBe('hello')
  })

  it('handles Buffer input by converting to string', async () => {
    const { conn, sent } = makeConn()
    const writer = new IpcChunkWriter(conn, 's1')

    await new Promise<void>((resolve, reject) => {
      writer.write(Buffer.from('world'), (err) => err ? reject(err) : resolve())
    })

    expect((sent[0] as any).token).toBe('world')
  })
})
