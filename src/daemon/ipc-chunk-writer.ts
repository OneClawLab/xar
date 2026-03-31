/**
 * IPC Chunk Writer - implements Writable stream for streaming LLM tokens via IPC.
 *
 * Uses stream_id for event correlation per ARCH.md.
 */

import { Writable } from 'stream'
import type { IpcConnection } from '../ipc/types.js'

export class IpcChunkWriter extends Writable {
  constructor(
    private conn: IpcConnection,
    private streamId: string,
  ) {
    super()
  }

  _write(chunk: Buffer | string, encoding: BufferEncoding | undefined, callback: (error?: Error | null) => void): void {
    try {
      const token = typeof chunk === 'string' ? chunk : chunk.toString('utf8')

      this.conn.send({
        type: 'stream_token',
        stream_id: this.streamId,
        token,
      })

      callback()
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)))
    }
  }
}
